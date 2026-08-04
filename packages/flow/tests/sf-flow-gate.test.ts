import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSfFlow } from "../src/register.js";

function captureTool(name: string) {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((def: any) => tools.set(def.name, def)),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;
  registerSfFlow(pi);
  return tools.get(name);
}

const F = (severity: string, file = "a.ts", line = 1) => ({
  severity,
  file,
  line,
  summary: "s",
  failure_scenario: "sc",
});

describe("sf_flow_gate canonical-round (M6)", () => {
  it("round 1 numbers the fresh findings and reports approved=null (verdict-based)", async () => {
    const tool = captureTool("sf_flow_gate");
    const res = await tool.execute("id", {
      mode: "canonical-round",
      round: 1,
      prior: [],
      verification: [],
      newFindings: [F("P1"), F("P3")],
    });
    expect(res.details.approved).toBeNull();
    expect(res.details.canonical).toHaveLength(2);
    expect(res.details.rendered).toContain("[F1]");
    expect(res.details.rendered).toContain("### P1");
  });

  it("round 2 APPROVES when every prior blocking finding is FIXED and no new blocking", async () => {
    const tool = captureTool("sf_flow_gate");
    const res = await tool.execute("id", {
      mode: "canonical-round",
      round: 2,
      prior: [F("P1")],
      verification: [{ ref: "F1", status: "FIXED", evidence: "done" }],
      newFindings: [],
    });
    expect(res.details.approved).toBe(true);
    expect(res.details.canonical).toHaveLength(0); // FIXED dropped
  });

  it("round 2 does NOT approve when a prior blocking finding is NOT-FIXED", async () => {
    const tool = captureTool("sf_flow_gate");
    const res = await tool.execute("id", {
      mode: "canonical-round",
      round: 2,
      prior: [F("P1")],
      verification: [{ ref: "F1", status: "NOT-FIXED", evidence: "still there" }],
      newFindings: [],
    });
    expect(res.details.approved).toBe(false);
    expect(res.details.canonical).toHaveLength(1); // kept
  });

  it("round 2 does NOT approve when a new blocking regression appears", async () => {
    const tool = captureTool("sf_flow_gate");
    const res = await tool.execute("id", {
      mode: "canonical-round",
      round: 2,
      prior: [F("P1")],
      verification: [{ ref: "F1", status: "FIXED", evidence: "done" }],
      newFindings: [F("P0")],
    });
    expect(res.details.approved).toBe(false);
  });
});
