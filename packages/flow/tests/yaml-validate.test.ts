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
  it("rejects a reserved name (sf-flow- / sf_flow_ prefix)", () => {
    expect(validateFlowYaml({ ...base, name: "sf-flow-seed" }).ok).toBe(false);
    expect(validateFlowYaml({ ...base, name: "sf_flow_audit" }).ok).toBe(false);
  });
  it("rejects phase with no agent/skill/raw", () => {
    expect(validateFlowYaml({ ...base, phases: [{ id: "p", prompt: "do" }] }).ok).toBe(false);
  });
  it("rejects phase.agent not in agents", () => {
    expect(validateFlowYaml({ ...base, phases: [{ id: "p", agent: "ghost", prompt: "do" }] }).ok).toBe(false);
  });
  it("rejects a fanout phase that declares no out", () => {
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
  it("rejects fanout on a skill phase (generator can't honor it)", () => {
    expect(
      validateFlowYaml({
        ...base,
        phases: [{ id: "p", skill: "sf-flow-plan", fanout: "files", out: "x" }],
      }).ok,
    ).toBe(false);
  });
  it("rejects fanout on a raw phase", () => {
    expect(
      validateFlowYaml({
        ...base,
        phases: [{ id: "p", raw: "doStuff()", fanout: "files", out: "x" }],
      }).ok,
    ).toBe(false);
  });
  it("rejects a phase setting more than one of agent/skill/raw", () => {
    expect(
      validateFlowYaml({
        ...base,
        phases: [{ id: "p", agent: "a", skill: "sf-flow-plan", prompt: "do", out: "x" }],
      }).ok,
    ).toBe(false);
  });
  it("rejects duplicate out values across phases", () => {
    expect(
      validateFlowYaml({
        ...base,
        phases: [
          { id: "p1", agent: "a", prompt: "do", out: "dup" },
          { id: "p2", agent: "a", prompt: "do", out: "dup" },
        ],
      }).ok,
    ).toBe(false);
  });
  it("rejects undeclared questions agent", () => {
    expect(
      validateFlowYaml({
        ...base,
        agents: { ...base.agents, elicitor: { model: "haiku" } },
        phases: [{ id: "clarify", questions: "ghost", max_rounds: 5, out: "reqs" }],
      }).errors,
    ).toContain('phase "clarify": questions "ghost" not defined in agents');
  });
  it("rejects questions + fanout", () => {
    expect(
      validateFlowYaml({
        ...base,
        agents: { ...base.agents, elicitor: { model: "haiku" } },
        phases: [{ id: "clarify", questions: "elicitor", fanout: "items", max_rounds: 5, out: "reqs" }],
      }).errors,
    ).toContain('phase "clarify": questions and fanout are mutually exclusive');
  });
  it("accepts a valid questions phase", () => {
    expect(
      validateFlowYaml({
        ...base,
        agents: { ...base.agents, elicitor: { model: "haiku" } },
        phases: [{ id: "clarify", questions: "elicitor", max_rounds: 5, out: "reqs" }],
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  // S-14: groups cross-field rules
  it("accepts a valid group with matching loop", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "review" },
        { id: "fix", agent: "a", prompt: "fix" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow)).toEqual({ ok: true, errors: [] });
  });
  it("rejects a group referencing a nonexistent phase", () => {
    const flow = {
      ...base,
      groups: { review: { phases: ["gate", "ghost"] } },
      phases: [{ id: "gate", agent: "a", prompt: "r" }],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'groups.review: phase "ghost" does not exist',
    );
  });
  it("rejects a phase belonging to two groups", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: {
        g1: { phases: ["p", "fix1"] },
        g2: { phases: ["p", "fix2"] },
      },
      phases: [
        { id: "p", agent: "a", prompt: "gate", out: "o" },
        { id: "fix1", agent: "a", prompt: "f1" },
        { id: "fix2", agent: "a", prompt: "f2" },
      ],
      loops: { g1: { until: "approved", fail_on: ["P0"], max_rounds: 5 }, g2: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'groups.g2: phase "p" already belongs to group "g1"',
    );
  });
  it("rejects a skill phase in a group", () => {
    const flow = {
      ...base,
      groups: { review: { phases: ["gate", "sk"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "sk", skill: "sf-flow-plan", out: "x" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'groups.review: phase "sk" must be an agent phase (skill/raw/questions phases cannot participate in group loops)',
    );
  });
  it("rejects a group with no matching loop", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "fix", agent: "a", prompt: "f" },
      ],
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'groups.review: no matching loops.review (a group must be looped)',
    );
  });
});
