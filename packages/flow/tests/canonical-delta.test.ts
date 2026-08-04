import { describe, it, expect } from "vitest";
import { generateScript } from "../src/yaml/generate.js";
import { validateFlowYaml } from "../src/yaml/validate.js";

const baseFlow = {
  name: "g", description: "d", input: "prompt" as const,
  agents: { reviewer: { model: "sonnet", schema: { verdict: "APPROVED|REVISE", findings: "array" } }, dev: { model: "sonnet" } },
  groups: { review: { phases: ["gate", "fix"] } },
  phases: [
    { id: "gate", agent: "reviewer", prompt: "review" },
    { id: "fix", agent: "dev", prompt: "fix" },
  ],
  loops: { review: { until: "approved" as const, fail_on: ["P0", "P1", "P2"], max_rounds: 5 } },
};

describe("canonical-delta validation (M6)", () => {
  it("accepts a canonical-delta group loop whose gate agent declares verdict + findings", () => {
    const r = validateFlowYaml({ ...baseFlow, loops: { review: { ...baseFlow.loops.review, protocol: "canonical-delta" } } });
    expect(r.ok).toBe(true);
  });

  it("rejects canonical-delta when the gate agent lacks a findings schema", () => {
    const noFindings = {
      ...baseFlow,
      agents: { reviewer: { model: "sonnet", schema: { verdict: "APPROVED|REVISE" } }, dev: { model: "sonnet" } },
      loops: { review: { ...baseFlow.loops.review, protocol: "canonical-delta" as const } },
    };
    const r = validateFlowYaml(noFindings);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/canonical-delta.*findings schema/i);
  });

  it("rejects canonical-delta on a single-phase loop (group-only)", () => {
    const single: any = {
      name: "s", description: "d", input: "prompt",
      agents: { reviewer: { schema: { verdict: "APPROVED|REVISE", findings: "array" } } },
      phases: [{ id: "rev", agent: "reviewer", prompt: "review", out: "v" }],
      loops: { rev: { until: "approved", fail_on: ["P0"], max_rounds: 3, protocol: "canonical-delta" } },
    };
    const r = validateFlowYaml(single);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/canonical-delta is only valid on a group loop/i);
  });

  it("rejects canonical-delta on a group loop without until: approved (would crash — _gateApproved not emitted)", () => {
    const noUntil: any = {
      ...baseFlow,
      loops: { review: { fail_on: ["P0"], max_rounds: 5, protocol: "canonical-delta" } },
    };
    const r = validateFlowYaml(noUntil);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/canonical-delta requires until: approved/i);
  });
});

describe("canonical-delta generator emission (M6)", () => {
  it("emits sf_flow_gate + carried canonical state for a canonical-delta group", () => {
    const s = generateScript({ ...baseFlow, loops: { review: { ...baseFlow.loops.review, protocol: "canonical-delta" as const } } } as any);
    expect(s).toContain("let _canonical = []");
    expect(s).toContain("let _rendered =");
    expect(s).toContain("sf_flow_gate(");
    expect(s).toContain('"canonical-round"');
    expect(s).toContain("_cr.details?.approved"); // round>=2 AND-gate
    expect(s).toContain("Canonical findings to address:"); // fix phases get the canonical list
  });

  it("a raw (default) group does NOT emit canonical-delta machinery", () => {
    const s = generateScript(baseFlow as any);
    expect(s).not.toContain("sf_flow_gate(");
    expect(s).not.toContain("let _canonical");
    // raw still gates via _gateApproved and addresses the latest findings
    expect(s).toContain("_gateApproved");
    expect(s).toContain("Canonical findings to address:");
  });

  it("canonical-delta group still checkpoints the group entity (resume-safe)", () => {
    const s = generateScript({ ...baseFlow, loops: { review: { ...baseFlow.loops.review, protocol: "canonical-delta" as const } } } as any);
    expect(s).toMatch(/mode:\s*"complete"[^]*phase:\s*"review"/);
    expect(s).toMatch(/mode:\s*"write"[^]*phase:\s*"review"[^]*status:\s*"blocked"/);
  });
});
