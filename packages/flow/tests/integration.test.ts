import { describe, it, expect } from "vitest";
import { generateScript } from "../src/yaml/generate.js";
import { validateFlowYaml } from "../src/yaml/validate.js";
import { andGatePasses } from "../src/audit/requestreview.js";
import { renderReport } from "../src/audit/verdict.js";
import type { FlowYaml } from "../src/yaml/schema.js";

// ship-feature flow (plan -> implement -> audit) from the examples
const shipFeature: FlowYaml = {
  name: "ship-feature",
  description: "d",
  input: "prompt",
  agents: { auditor: { model: "sonnet", thinking: "high", isolated: true, schema: { verdict: "APPROVED|REVISE" } } },
  phases: [
    { id: "plan", skill: "sf-flow-plan", out: "plan_path" },
    { id: "implement", skill: "sf-flow-implement", in: "plan_path", out: "worktree_path" },
    { id: "audit", agent: "auditor", in: "worktree_path", prompt: "Review {{worktree_path}}." },
  ],
  loops: { audit: { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 5 } },
};

describe("end-to-end chain (mocked engine)", () => {
  it("validates + generates a deterministic script for the ship-feature flow", () => {
    expect(validateFlowYaml(shipFeature).ok).toBe(true);
    const a = generateScript(shipFeature);
    const b = generateScript(shipFeature);
    expect(a).toBe(b);
    expect(a).toContain("gate("); // audit loop compiles to gate()
    expect(a).toContain("sf-flow-plan"); // skill phase present
  });

  it("audit gate: REVISE on a P1 finding, APPROVED when clean", () => {
    const threshold = 0.94;
    const revise = { score: 0.95, mustFix: 1 }; // has a P1 -> must-fix
    const approve = { score: 0.97, mustFix: 0 };
    expect(andGatePasses(revise, approve, threshold)).toBe(false); // AND-gate fails
    expect(andGatePasses(approve, approve, threshold)).toBe(true); // both clean -> pass
  });

  it("renderReport reproduces pair's P0-P3 + verdict format for a merged result", () => {
    const out = renderReport({
      findings: [
        { severity: "P1", file: "src/a.ts", line: 7, summary: "null deref", failure_scenario: "x=null -> crash" },
      ],
      verdict: "REVISE",
    });
    expect(out).toContain("### P1");
    expect(out).toContain("src/a.ts:7");
    expect(out).toContain("VERDICT: REVISE");
  });

  it("plan->implement handoff artifact contract: each phase's out var is emitted", () => {
    const script = generateScript(shipFeature);
    expect(script).toMatch(/plan_path/);
    expect(script).toMatch(/worktree_path/);
  });
});
