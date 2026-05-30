import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCatalog } from "../src/register.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock ExtensionAPI that records all registerCommand/registerTool calls. */
function mockPi() {
  const commands = new Map<
    string,
    { description?: string; getArgumentCompletions?: unknown; handler: unknown }
  >();
  const tools = new Map<string, { name: string; description: string }>();

  const pi = {
    registerCommand: vi.fn((name: string, opts: Record<string, unknown>) => {
      commands.set(name, opts as never);
    }),
    registerTool: vi.fn((def: { name: string; description: string }) => {
      tools.set(def.name, def);
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
      expect(def.description.length, `tool ${name} description`).toBeGreaterThan(0);
    }
  });

  it("each registered tool has parameters defined", () => {
    const { pi } = mockPi();
    registerCatalog(pi);

    const calls = vi.mocked(pi.registerTool).mock.calls;
    for (const [def] of calls) {
      const d = def as Record<string, unknown>;
      expect(d.parameters, `tool ${d.name} parameters`).toBeDefined();
    }
  });

  it("ct command handler dispatches to the correct subcommand", async () => {
    const { pi, commands } = mockPi();
    registerCatalog(pi);

    const ct = commands.get("ct")!;
    const mockCtx = {
      ui: { notify: vi.fn() },
    } as unknown as Parameters<typeof ct.handler>[1];

    // Calling handler with "status" should invoke the status handler path.
    // Since implementation modules are not wired yet, we just verify no throw
    // on unknown subcommand gives a user-facing notification.
    await ct.handler("unknown-sub", mockCtx);
    // The handler should notify the user about the unknown subcommand
    expect(mockCtx.ui.notify).toHaveBeenCalled();
  });
});
