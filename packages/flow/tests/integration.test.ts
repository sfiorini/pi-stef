import { describe, it, expect } from "vitest";
import { generateScript } from "../src/yaml/generate.js";
import { validateFlowYaml } from "../src/yaml/validate.js";
import { andGatePasses } from "../src/audit/requestreview.js";
import { renderReport } from "../src/audit/verdict.js";
import type { FlowYaml } from "../src/yaml/schema.js";

// Decomposed ship-feature flow: clarify → design → plan → plan-review loop → implement → impl-review loop → audit loop.
// F2 invariant: clarify keeps its prompt.
const shipFeature: FlowYaml = {
  name: "ship-feature",
  description: "Clarify, design, plan, implement, and audit a feature end-to-end",
  input: "prompt",
  agents: {
    elicitor: { tools: ["read", "grep", "find", "ls"], thinking: "high", isolated: true, schema: { questions: "array" } },
    designer: { tools: ["read", "grep", "find", "ls"], thinking: "high", isolated: true },
    planner: { tools: ["read", "grep", "find", "ls"], thinking: "medium", isolated: true },
    developer: { tools: ["read", "grep", "find", "ls", "write", "bash"], thinking: "medium" },
    reviewer: { tools: ["read", "grep", "find", "ls"], thinking: "high", isolated: true, schema: { verdict: "APPROVED|REVISE", findings: "array" } },
    auditor: { tools: ["read", "grep", "find", "ls"], thinking: "high", isolated: true, schema: { verdict: "APPROVED|REVISE", findings: "array" } },
  },
  groups: {
    "plan-review": { phases: ["review-plan", "fix-plan"] },
    "impl-review": { phases: ["review-impl", "fix-impl"] },
    "audit-loop": { phases: ["review-audit", "fix-audit"] },
  },
  phases: [
    { id: "clarify", questions: "elicitor", prompt: "Given this feature request, identify what is unclear about scope, constraints, success criteria, and edge cases. Return a questions array — empty if the task is clear enough to design.", max_rounds: 5, out: "requirements" },
    { id: "design", agent: "designer", in: "requirements", out: "design_doc", prompt: "Design." },
    { id: "plan", agent: "planner", in: "design_doc", out: "plan_doc", prompt: "Plan." },
    { id: "review-plan", agent: "reviewer", in: "plan_doc", prompt: "Review plan." },
    { id: "fix-plan", agent: "planner", in: "plan_doc", prompt: "Fix plan." },
    { id: "implement", agent: "developer", in: "plan_doc", out: "impl_result", prompt: "Implement." },
    { id: "review-impl", agent: "reviewer", in: "impl_result", prompt: "Review impl." },
    { id: "fix-impl", agent: "developer", in: "impl_result", prompt: "Fix impl." },
    { id: "review-audit", agent: "auditor", in: "impl_result", prompt: "Audit." },
    { id: "fix-audit", agent: "developer", in: "impl_result", prompt: "Fix audit." },
  ],
  loops: {
    "plan-review": { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 10 },
    "impl-review": { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 5 },
    "audit-loop": { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 5 },
  },
};

describe("end-to-end chain (mocked engine)", () => {
  it("validates + generates a deterministic script for the decomposed ship-feature flow", () => {
    expect(validateFlowYaml(shipFeature).ok).toBe(true);
    const a = generateScript(shipFeature);
    const b = generateScript(shipFeature);
    expect(a).toBe(b);
    expect(a).toContain("QUESTIONS PHASE");
    expect(a).toContain("for (let _round");
  });

  it("decomposed ship-feature has no INLINE SKILL PHASE directives", () => {
    const script = generateScript(shipFeature);
    expect(script).not.toContain("INLINE SKILL PHASE");
    expect(script).not.toMatch(/agentType:\s*['"]general-purpose['"]/);
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

  it("rewritten code-review flow runs an audit↔fix group loop (no INLINE SKILL PHASE)", () => {
    const codeReview: FlowYaml = {
      name: "code-review", description: "d", input: "prompt",
      agents: {
        auditor: { tools: ["read", "grep", "find", "ls"], model: "sonnet", thinking: "high", isolated: true, schema: { verdict: "APPROVED|REVISE", findings: "array" } },
        developer: { tools: ["read", "grep", "find", "ls", "write", "bash"], model: "sonnet", thinking: "medium" },
      },
      groups: { review: { phases: ["review", "fix"] } },
      phases: [ { id: "review", agent: "auditor", prompt: "Audit the diff." }, { id: "fix", agent: "developer", prompt: "Fix the findings." } ],
      loops: { review: { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 5 } },
    };
    const script = generateScript(codeReview);
    expect(script).toContain('phase("review");');
    expect(script).toContain("for (let _round");
    expect(script).toContain("Canonical findings to address");
    expect(script).not.toContain("INLINE SKILL PHASE");
  });
});
