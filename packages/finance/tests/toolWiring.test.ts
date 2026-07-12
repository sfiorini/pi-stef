import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerFinanceTools } from "../src/tools";

// Mock ExtensionAPI that captures registerTool calls
interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
}

function createMockPi() {
  const tools: ToolRegistration[] = [];
  return {
    registerTool: (tool: ToolRegistration) => { tools.push(tool); },
    getTools: () => tools,
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
});
