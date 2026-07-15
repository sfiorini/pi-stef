import { describe, it, expect } from "vitest";
import { validateFlowYaml } from "../src/yaml/validate.js";

const base = {
  name: "x",
  description: "d",
  input: "prompt",
  agents: { a: { model: "haiku" } },
  phases: [{ id: "p", agent: "a", prompt: "do", out: "o" }],
};

describe("validateFlowYaml", () => {
  it("passes a valid flow", () => {
    expect(validateFlowYaml(base)).toEqual({ ok: true, errors: [] });
  });
  it("rejects phase with no agent/skill/raw", () => {
    expect(validateFlowYaml({ ...base, phases: [{ id: "p", prompt: "do" }] }).ok).toBe(false);
  });
  it("rejects phase.agent not in agents", () => {
    expect(validateFlowYaml({ ...base, phases: [{ id: "p", agent: "ghost", prompt: "do" }] }).ok).toBe(false);
  });
  it("rejects fanout referencing undefined out var", () => {
    expect(
      validateFlowYaml({ ...base, phases: [{ id: "p", agent: "a", fanout: "missing", prompt: "do" }] }).ok,
    ).toBe(false);
  });
  it("rejects loops.until:approved without agent verdict schema", () => {
    expect(
      validateFlowYaml({ ...base, loops: { p: { until: "approved", fail_on: ["P0"], max_rounds: 5 } } }).ok,
    ).toBe(false);
  });
  it("accepts loops.until:approved when agent has verdict schema", () => {
    const withVerdict = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      loops: { p: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(withVerdict).ok).toBe(true);
  });
  it("rejects loops.until_dry without fanout (discovery needs a list)", () => {
    expect(validateFlowYaml({ ...base, loops: { p: { until_dry: true, max_rounds: 3 } } }).ok).toBe(false);
  });
  it("accepts loops.until_dry with fanout", () => {
    const f = {
      ...base,
      phases: [{ id: "scan", agent: "a", fanout: "files", prompt: "do {{item}}", out: "found" }],
      loops: { scan: { until_dry: true, max_rounds: 3 } },
    };
    expect(validateFlowYaml(f).ok).toBe(true);
  });
  it("rejects loops on a skill phase", () => {
    expect(
      validateFlowYaml({
        ...base,
        phases: [{ id: "p", skill: "sf-flow-plan", out: "x" }],
        loops: { p: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
      }).ok,
    ).toBe(false);
  });
});
