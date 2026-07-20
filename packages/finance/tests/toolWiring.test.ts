import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerFinanceTools } from "../src/tools";

// Mock ExtensionAPI that captures registerTool and registerCommand calls
interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
}

interface CommandRegistration {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createMockPi() {
  const tools: ToolRegistration[] = [];
  const commands: CommandRegistration[] = [];
  const sentMessages: { content: string; opts?: { deliverAs?: string } }[] = [];
  return {
    registerTool: (tool: ToolRegistration) => { tools.push(tool); },
    registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.push({ name, description: opts.description, handler: opts.handler });
    },
    sendUserMessage: (content: string, opts?: { deliverAs?: string }) => {
      sentMessages.push({ content, opts });
    },
    getTools: () => tools,
    getCommands: () => commands,
    getSentMessages: () => sentMessages,
  };
}

describe("tool wiring", () => {
  it("registers all expected sf_fin_* tools", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const toolNames = pi.getTools().map((t) => t.name);
    const expectedTools = [
      "sf_fin_market_status",
      "sf_fin_get_holdings",
      "sf_fin_get_net_worth",
      "sf_fin_get_drift",
      "sf_fin_get_allocation",
      "sf_fin_list_goals",
      "sf_fin_set_target",
      "sf_fin_get_suggestions",
      "sf_fin_dismiss_suggestion",
      "sf_fin_sync_now",
      "sf_fin_import_file",
      "sf_fin_history",
    ];

    for (const expected of expectedTools) {
      expect(toolNames).toContain(expected);
    }
  });

  it("each tool has required fields", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const tool of pi.getTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("every tool's parameters schema is a valid object (has type: 'object')", () => {
    // Regression guard: no-param tools must still declare { type: "object", ... }.
    // A bare `parameters: {}` has no `type`, which strict providers (deepseek, et al.)
    // reject with "Invalid schema ... got 'type: null'", breaking subagent dispatch.
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const tool of pi.getTools()) {
      const params = tool.parameters as Record<string, unknown> | undefined;
      expect(params, `tool "${tool.name}" has no parameters object`).toBeDefined();
      expect(params!.type, `tool "${tool.name}" parameters must have type: "object"`).toBe("object");
    }
  });

  it("each tool has promptGuidelines with never-recompute invariant", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const tool of pi.getTools()) {
      expect(tool.promptGuidelines).toBeDefined();
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines![0]).toContain("Never recompute");
    }
  });
});

describe("sf_fin_sync_now — provider scoping + credentials", () => {
  const origHome = process.env.HOME;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { message: "Sync complete" } }), { status: 200 })) as never;
  });
  afterEach(() => {
    process.env.HOME = origHome;
  });

  function withConfigHome(config: unknown): string {
    const home = mkdtempSync(path.join(tmpdir(), "fin-sync-"));
    const dir = path.join(home, ".pi", "sf", "finance");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    process.env.HOME = home;
    return home;
  }

  function getSyncTool() {
    const pi = createMockPi();
    registerFinanceTools(pi as never);
    return pi.getTools().find((t) => t.name === "sf_fin_sync_now")!;
  }

  function lastRequestBody(): Record<string, unknown> {
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const last = calls[calls.length - 1];
    const init = last[1] as { body?: string };
    return init.body ? JSON.parse(init.body) : {};
  }

  it("attaches snaptrade credentials + providers when provider:'snaptrade' and creds configured", async () => {
    withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { snaptrade: { clientId: "PERS-1", consumerKey: "ck" } },
    });
    const tool = getSyncTool();
    await tool.execute("test-call", { provider: "snaptrade" });
    const body = lastRequestBody();
    expect(body.providers).toEqual(["snaptrade"]);
    expect(body.credentials).toMatchObject({ snaptrade: { clientId: "PERS-1", consumerKey: "ck" } });
  });

  it("attaches snaptrade credentials even when syncing ALL providers (no provider arg)", async () => {
    withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { snaptrade: { clientId: "PERS-1", consumerKey: "ck" } },
    });
    const tool = getSyncTool();
    await tool.execute("test-call", {});
    const body = lastRequestBody();
    expect(body.providers).toBeUndefined();  // all providers
    expect(body.credentials).toMatchObject({ snaptrade: { clientId: "PERS-1", consumerKey: "ck" } });
  });

  it("omits credentials key entirely when snaptrade not configured", async () => {
    withConfigHome({ apiUrl: "http://127.0.0.1:7780", token: "tok" });
    const tool = getSyncTool();
    await tool.execute("test-call", { provider: "snaptrade" });
    const body = lastRequestBody();
    expect(body.credentials).toBeUndefined();
    expect(body.providers).toEqual(["snaptrade"]);  // scoped, but no creds → server-side no-op
  });

  it("sends simplefin creds alongside snaptrade creds", async () => {
    withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: {
        snaptrade: { clientId: "PERS-1", consumerKey: "ck" },
        simplefin: { setupToken: "abc123" },
      },
    });
    const tool = getSyncTool();
    await tool.execute("test-call", {});
    const body = lastRequestBody();
    expect(body.credentials).toMatchObject({
      snaptrade: { clientId: "PERS-1", consumerKey: "ck" },
      simplefin: { setupToken: "abc123" },
    });
  });

  it("persists resolvedCredentials.simplefin.accessUrl to config after sync", async () => {
    const home = withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { simplefin: { setupToken: "old-token" } },
    });
    // Mock fetch to return resolvedCredentials in the response
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { message: "Sync complete", resolvedCredentials: { simplefin: { accessUrl: "https://resolved:url@host/simplefin" } } },
    }), { status: 200 })) as never;

    const tool = getSyncTool();
    await tool.execute("test-call", {});

    // Config should now have accessUrl instead of setupToken
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(path.join(home, ".pi", "sf", "finance", "config.json"), "utf8"));
    expect(raw.providers.simplefin.accessUrl).toBe("https://resolved:url@host/simplefin");
    // setupToken should be gone (replaced)
    expect(raw.providers.simplefin.setupToken).toBeUndefined();
  });
});

describe("slash commands", () => {
  const expectedCommands = [
    "sf-fin-market-status",
    "sf-fin-get-holdings",
    "sf-fin-get-net-worth",
    "sf-fin-get-drift",
    "sf-fin-get-allocation",
    "sf-fin-list-goals",
    "sf-fin-set-target",
    "sf-fin-get-suggestions",
    "sf-fin-dismiss-suggestion",
    "sf-fin-sync-now",
    "sf-fin-import-file",
    "sf-fin-history",
  ];

  it("registers a slash command for every tool", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmdNames = pi.getCommands().map((c) => c.name);
    for (const expected of expectedCommands) {
      expect(cmdNames, `missing slash command: ${expected}`).toContain(expected);
    }
  });

  it("every slash command has a description", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const cmd of pi.getCommands()) {
      expect(cmd.description, `command "${cmd.name}" has no description`).toBeTruthy();
    }
  });

  it("one-to-one: every tool has a matching slash command (kebab-case)", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const toolNames = pi.getTools().map((t) => t.name);
    const cmdNames = pi.getCommands().map((c) => c.name);

    for (const toolName of toolNames) {
      const expectedSlash = toolName.replace(/_/g, "-");
      expect(cmdNames, `tool "${toolName}" has no matching slash command`).toContain(expectedSlash);
    }
  });

  it("no-arg tool delegates directly", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-market-status")!;
    await cmd.handler("", { isIdle: () => true });

    expect(pi.getSentMessages()).toHaveLength(1);
    expect(pi.getSentMessages()[0].content).toBe("Invoke the sf_fin_market_status tool.");
  });

  it("get-holdings with arg delegates with symbol", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-get-holdings")!;
    await cmd.handler("AAPL", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("symbol: AAPL");
  });

  it("sync-now with provider arg", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-sync-now")!;
    await cmd.handler("snaptrade", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("provider: snaptrade");
  });

  it("sync-now without args syncs all providers", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-sync-now")!;
    await cmd.handler("", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("sync all providers");
  });

  it("import-file without arg asks for path", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-import-file")!;
    await cmd.handler("", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("Ask me for the file path");
  });

  it("import-file with arg delegates with filePath", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-import-file")!;
    await cmd.handler("~/Downloads/positions.csv", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("filePath: ~/Downloads/positions.csv");
  });

  it("history without arg asks for symbol", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-history")!;
    await cmd.handler("", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("Ask me for the symbol");
  });

  it("dismiss-suggestion without arg asks for ID", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-dismiss-suggestion")!;
    await cmd.handler("", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("Ask me for the suggestion ID");
  });

  it("set-target delegates to wizard (ignores args)", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-set-target")!;
    await cmd.handler("anything here", { isIdle: () => true });

    expect(pi.getSentMessages()[0].content).toContain("create or update an investment goal");
  });

  it("uses followUp delivery when agent is not idle", async () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-get-net-worth")!;
    await cmd.handler("", { isIdle: () => false });

    expect(pi.getSentMessages()[0].opts?.deliverAs).toBe("followUp");
  });

  it("warns when sendUserMessage is unavailable", async () => {
    const pi = createMockPi();
    // Remove sendUserMessage to simulate unsupported runtime
    (pi as Record<string, unknown>).sendUserMessage = undefined;
    registerFinanceTools(pi as never);

    const notifications: string[] = [];
    const cmd = pi.getCommands().find((c) => c.name === "sf-fin-market-status")!;
    await cmd.handler("", {
      isIdle: () => true,
      ui: { notify: (msg: string) => notifications.push(msg) },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("can't post slash-command output");
  });
});
