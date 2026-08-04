import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLOW_TOOL_NAMES, registerSfFlow } from "../src/register.js";

// Helper tools the generator emits around contracts. They are registered as pi
// tools (so the orchestrator can call them) but are NOT user slash commands, so
// they are intentionally absent from FLOW_TOOL_NAMES.
const HELPER_TOOLS = ["sf_flow_contract", "sf_flow_checkpoint", "sf_flow_prepare"];

describe("flow register", () => {
  it("exports the expected tool names", () => {
    expect(FLOW_TOOL_NAMES).toEqual([
      "sf_flow_plan",
      "sf_flow_implement",
      "sf_flow_audit",
      "sf_flow_auto",
      "sf_flow_create_workflow",
      "sf_flow_finalize",
      "sf_flow_seed",
    ]);
  });

  it("registers /sf-flow-* slash commands that route to the tools (command -> tool -> skill)", () => {
    // flow is command-driven like pair: /sf-flow-* commands are the user entry,
    // routing to the sf_flow_* tools (which do setup, then load the internal
    // skill by path). The skills are NOT pi-discovered (pi.skills: []), so the
    // commands are flow's only listing entry.
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: vi.fn((def: { name: string }) => tools.push(def.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    } as unknown as ExtensionAPI;

    registerSfFlow(pi);

    // Every user-facing tool is registered and gets a matching slash command.
    expect([...FLOW_TOOL_NAMES].sort()).toEqual(
      ["sf_flow_plan", "sf_flow_implement", "sf_flow_audit", "sf_flow_auto", "sf_flow_create_workflow", "sf_flow_finalize", "sf_flow_seed"].sort(),
    );
    expect([...FLOW_TOOL_NAMES].every((n) => tools.includes(n))).toBe(true);
    expect([...commands].sort()).toEqual(
      ["sf-flow-plan", "sf-flow-implement", "sf-flow-audit", "sf-flow-auto", "sf-flow-create-workflow", "sf-flow-finalize", "sf-flow-seed"].sort(),
    );
  });

  it("registers the contract helper tools (emitted by the generator, no slash commands)", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: vi.fn((def: { name: string }) => tools.push(def.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    } as unknown as ExtensionAPI;
    registerSfFlow(pi);
    for (const h of HELPER_TOOLS) expect(tools).toContain(h);
    // helper tools must NOT become user slash commands
    for (const h of HELPER_TOOLS) expect(commands).not.toContain(h.replace(/_/g, "-"));
  });
});
