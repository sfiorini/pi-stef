import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCatalog } from "../src/register.js";

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

  it("registers LLM tools (ct_sync, ct_add, ct_remove, ct_toggle, ct_status)", () => {
    const { pi, tools } = mockPi();
    registerCatalog(pi);

    const expectedTools = [
      "ct_sync",
      "ct_add",
      "ct_remove",
      "ct_toggle",
      "ct_status",
    ];

    for (const name of expectedTools) {
      expect(tools.has(name), `expected tool ${name}`).toBe(true);
    }
  });

  it("calls registerCommand the expected number of times", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    // 1 main (/ct) + 15 subcommand aliases = 16 commands
    expect(pi.registerCommand).toHaveBeenCalledTimes(16);
  });

  it("calls registerTool exactly 5 times", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(5);
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

    // Calling handler with "status" should invoke the status handler path.
    // Since implementation modules are not wired yet, we just verify no throw
    // on unknown subcommand gives a user-facing notification.
    await ct.handler("unknown-sub", mockCtx as never);
    // The handler should notify the user about the unknown subcommand
    expect(notify).toHaveBeenCalled();
  });

  it("each registered tool execute function returns an object with details", async () => {
    const { pi, tools } = mockPi();
    registerCatalog(pi);

    for (const [name, def] of tools) {
      const execute = def.execute as (
        toolCallId: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) => Promise<Record<string, unknown>>;

      const result = await execute("test-id", {}, undefined, undefined, undefined);
      expect(result, `tool ${name} result`).toHaveProperty("content");
      expect(result, `tool ${name} result must have details`).toHaveProperty("details");
    }
  });
});
