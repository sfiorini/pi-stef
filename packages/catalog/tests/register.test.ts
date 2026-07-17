import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCatalog, withToolReload } from "../src/register.js";
import { reloadNotice } from "../src/commands/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCommand {
  description?: string;
  getArgumentCompletions?: unknown;
  handler: (args: string | undefined, ctx: Record<string, unknown>) => Promise<void>;
}

/** Create a mock ExtensionAPI that records all registerCommand/registerTool calls. */
function mockPi() {
  const commands = new Map<string, RecordedCommand>();
  const tools = new Map<string, Record<string, unknown>>();

  const pi = {
    registerCommand: vi.fn((name: string, opts: RecordedCommand) => {
      commands.set(name, opts);
    }),
    registerTool: vi.fn((def: Record<string, unknown>) => {
      tools.set(def.name as string, def);
    }),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  return { pi, commands, tools };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerCatalog", () => {
  it("registers the /ct main command", () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    expect(commands.has("ct")).toBe(true);
    const ct = commands.get("ct")!;
    expect(ct.description).toBeTruthy();
    expect(ct.getArgumentCompletions).toBeTypeOf("function");
  });

  it("registers /ct subcommand aliases (ct-sync, ct-init, etc.)", () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const expectedAliases = [
      "ct-sync",
      "ct-init",
      "ct-add",
      "ct-remove",
      "ct-toggle",
      "ct-disable",
      "ct-enable",
      "ct-push",
      "ct-pull",
      "ct-login",
      "ct-status",
      "ct-diff",
      "ct-verify",
      "ct-profiles",
      "ct-profile",
    ];

    for (const alias of expectedAliases) {
      expect(commands.has(alias), `expected command /${alias}`).toBe(true);
    }
  });

  it("registers LLM tools (ct_sync, ct_add, ct_remove, ct_update, ct_toggle, ct_status, ct_reset)", () => {
    const { pi, tools } = mockPi();
    registerCatalog(pi);

    const expectedTools = [
      "ct_sync",
      "ct_add",
      "ct_remove",
      "ct_update",
      "ct_toggle",
      "ct_status",
      "ct_reset",
    ];

    for (const name of expectedTools) {
      expect(tools.has(name), `expected tool ${name}`).toBe(true);
    }
  });

  it("calls registerCommand the expected number of times", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    // 1 main (/ct) + 17 subcommand aliases = 18 commands
    expect(pi.registerCommand).toHaveBeenCalledTimes(18);
  });

  it("calls registerTool exactly 7 times", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(7);
  });

  it("does not throw (smoke test)", () => {
    const { pi } = mockPi();
    expect(() => registerCatalog(pi)).not.toThrow();
  });

  it("each registered tool has a non-empty description", () => {
    const { pi, tools } = mockPi();
    registerCatalog(pi);

    for (const [name, def] of tools) {
      const desc = def.description as string;
      expect(desc.length, `tool ${name} description`).toBeGreaterThan(0);
    }
  });

  it("each registered tool has parameters defined", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    const calls = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    for (const [def] of calls) {
      const d = def as Record<string, unknown>;
      expect(d.parameters, `tool ${d.name} parameters`).toBeDefined();
    }
  });

  it("ct command handler dispatches to the correct subcommand", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ct = commands.get("ct")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    // Calling handler with "unknown-sub" should notify about unknown subcommand
    await ct.handler("unknown-sub", mockCtx as never);
    expect(notify).toHaveBeenCalled();
  });

  it("ct-add handler delegates to addCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctAdd = commands.get("ct-add")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    // addCommand with no args should show "Usage" error, not "not yet implemented"
    await ctAdd.handler("", mockCtx as never);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("not yet implemented"),
      expect.anything(),
    );
  });

  it("ct-remove handler delegates to removeCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctRemove = commands.get("ct-remove")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    // removeCommand with no args should show "Usage" error
    await ctRemove.handler("", mockCtx as never);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  it("ct-toggle handler delegates to toggleCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctToggle = commands.get("ct-toggle")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    // toggleCommand with no args should show "Usage" error
    await ctToggle.handler("", mockCtx as never);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  it("ct-enable handler delegates to enableCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctEnable = commands.get("ct-enable")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    await ctEnable.handler("", mockCtx as never);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  it("ct-disable handler delegates to disableCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctDisable = commands.get("ct-disable")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    await ctDisable.handler("", mockCtx as never);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  it("ct-init handler delegates to initCommand (not a stub)", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ctInit = commands.get("ct-init")!;
    const notify = vi.fn();
    const mockCtx = { ui: { notify } };

    // initCommand with no args should scan and notify (or show an error)
    // It should NOT say "not yet implemented"
    await ctInit.handler("", mockCtx as never);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("not yet implemented"),
      expect.anything(),
    );
  });

  it("each registered tool execute function returns an object with details", async () => {
    const { pi, tools } = mockPi();
    registerCatalog(pi);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-register-tools-"));
    const mockCtx = { ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) }, home: tmpDir };

    for (const [name, def] of tools) {
      const execute = def.execute as (
        toolCallId: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) => Promise<Record<string, unknown>>;

      const result = await execute("test-id", {}, undefined, undefined, mockCtx);
      expect(result, `tool ${name} result`).toHaveProperty("content");
      expect(result, `tool ${name} result must have details`).toHaveProperty("details");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // S19: LLM tool integration tests (delegation verification)
  // -------------------------------------------------------------------------

  describe("ct_sync tool execute", () => {
    it("delegates to syncCommand — calls notify (success path)", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_sync")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const notify = vi.fn();
      const result = await execute("id", {}, undefined, undefined, { ui: { notify } });
      expect(result).toHaveProperty("content");
      // syncCommand called notify => delegation happened
      expect(notify).toHaveBeenCalled();
    });

    it("catches thrown errors gracefully", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_sync")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      // Pass ctx with a notify that throws to force the error path
      const result = await execute("id", {}, undefined, undefined, {
        ui: { notify: () => { throw new Error("forced"); } },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Sync failed:");
    });
  });

  describe("ct_add tool execute", () => {
    it("delegates to addCommand — calls notify", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_add")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const notify = vi.fn();
      await execute("id", { name: "test", source: "npm:test" }, undefined, undefined, { ui: { notify } });
      expect(notify).toHaveBeenCalled();
    });

    it("catches thrown errors gracefully", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_add")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const result = await execute("id", { name: "test", source: "npm:test" }, undefined, undefined, {
        ui: { notify: () => { throw new Error("forced"); } },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Add failed:");
    });
  });

  describe("ct_remove tool execute", () => {
    it("delegates to removeCommand — calls notify", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_remove")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const notify = vi.fn();
      await execute("id", { name: "pkg" }, undefined, undefined, { ui: { notify } });
      expect(notify).toHaveBeenCalled();
    });

    it("catches thrown errors gracefully", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_remove")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const result = await execute("id", { name: "pkg" }, undefined, undefined, {
        ui: { notify: () => { throw new Error("forced"); } },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Remove failed:");
    });
  });

  describe("ct_toggle tool execute", () => {
    it("delegates to toggleCommand — calls notify", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_toggle")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const notify = vi.fn();
      await execute("id", { name: "pkg" }, undefined, undefined, { ui: { notify } });
      expect(notify).toHaveBeenCalled();
    });

    it("catches thrown errors gracefully", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_toggle")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const result = await execute("id", { name: "pkg" }, undefined, undefined, {
        ui: { notify: () => { throw new Error("forced"); } },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Toggle failed:");
    });
  });

  describe("ct_status tool execute", () => {
    it("delegates to statusCommand — calls notify", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_status")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const notify = vi.fn();
      await execute("id", {}, undefined, undefined, { ui: { notify } });
      expect(notify).toHaveBeenCalled();
    });
    it("catches thrown errors gracefully", async () => {
      const { pi, tools } = mockPi();
      registerCatalog(pi);
      const execute = tools.get("ct_status")!.execute as (...args: unknown[]) => Promise<Record<string, unknown>>;
      const result = await execute("id", {}, undefined, undefined, {
        ui: { notify: () => { throw new Error("forced"); } },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Status failed:");
    });
  });
});

// ---------------------------------------------------------------------------
// Tools can't call ctx.reload() directly (pi gives tool handlers ExtensionContext,
// not ExtensionCommandContext). withToolReload bridges that by queueing the
// builtin /reload command as a follow-up — see pi docs extensions.md → ctx.reload().
// ---------------------------------------------------------------------------
describe("withToolReload", () => {
  it("returns a ctx whose reload() queues /reload as a follow-up user message", async () => {
    const sendUserMessage = vi.fn();
    const pi = { sendUserMessage } as unknown as ExtensionAPI;
    const ctx = withToolReload(pi, { ui: { notify: vi.fn() } });

    expect(ctx.reloadQueued).toBe(true);
    expect(typeof ctx.reload).toBe("function");
    await ctx.reload();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("/reload", { deliverAs: "followUp" });
  });

  it("preserves the wrapped ctx's other fields", () => {
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const ctx = withToolReload(pi, { ui: { notify }, cwd: "/repo" });

    expect(ctx.cwd).toBe("/repo");
    expect(ctx.ui.notify).toBe(notify);
  });
});

// ---------------------------------------------------------------------------
// reloadNotice: honest post-reload messaging. The tool path queues /reload
// (it runs after the turn), so the message must not claim it already happened.
// ---------------------------------------------------------------------------
describe("reloadNotice", () => {
  it("returns the done message when reload is synchronous (slash-command path)", () => {
    const ctx = { reloadQueued: false } as never;
    expect(reloadNotice(ctx, "Extensions reloaded.")).toBe("Extensions reloaded.");
  });

  it("returns the queued message when reload is queued (tool path)", () => {
    const ctx = { reloadQueued: true } as never;
    expect(reloadNotice(ctx, "Extensions reloaded.")).toBe(
      "Reload queued — new tools available after this turn.",
    );
  });

  it("treats absent reloadQueued as synchronous (defaults to done message)", () => {
    expect(reloadNotice({} as never, "Extensions reloaded.")).toBe("Extensions reloaded.");
  });
});
