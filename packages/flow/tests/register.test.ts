import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLOW_TOOL_NAMES, registerSfFlow } from "../src/register.js";

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

    expect([...tools].sort()).toEqual([...FLOW_TOOL_NAMES].sort());
    expect([...commands].sort()).toEqual(
      ["sf-flow-plan", "sf-flow-implement", "sf-flow-audit", "sf-flow-auto", "sf-flow-create-workflow", "sf-flow-finalize", "sf-flow-seed"].sort(),
    );
  });
});
