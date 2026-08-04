import { describe, it, expect } from "vitest";
import { validateFlowYaml, validateSection, validateStrictProfile } from "../src/yaml/validate.js";

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

  // P0: Path traversal via name — must be kebab-case
  it("accepts valid kebab-case names", () => {
    expect(validateFlowYaml({ ...base, name: "code-review" }).ok).toBe(true);
    expect(validateFlowYaml({ ...base, name: "my-flow" }).ok).toBe(true);
    expect(validateFlowYaml({ ...base, name: "a1" }).ok).toBe(true);
    expect(validateFlowYaml({ ...base, name: "x" }).ok).toBe(true);
  });
  it("rejects path traversal in name", () => {
    const err = 'must be kebab-case (lowercase alphanumeric and hyphens, starting alphanumeric — no slashes, dots, or path traversal)';
    expect(validateFlowYaml({ ...base, name: "../evil" }).errors).toContain(`name "../evil": ${err}`);
    expect(validateFlowYaml({ ...base, name: "foo/bar" }).errors).toContain(`name "foo/bar": ${err}`);
    expect(validateFlowYaml({ ...base, name: "../../etc/x" }).errors).toContain(`name "../../etc/x": ${err}`);
    expect(validateFlowYaml({ ...base, name: "Foo" }).errors).toContain(`name "Foo": ${err}`);
    expect(validateFlowYaml({ ...base, name: "foo_bar" }).errors).toContain(`name "foo_bar": ${err}`);
    expect(validateFlowYaml({ ...base, name: "-leading" }).errors).toContain(`name "-leading": ${err}`);
    expect(validateFlowYaml({ ...base, name: "has.space" }).errors).toContain(`name "has.space": ${err}`);
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

  // Step 0 (M1 review P2): questions+verify mutual exclusion
  it("rejects questions + verify", () => {
    expect(
      validateFlowYaml({
        ...base,
        agents: { ...base.agents, elicitor: { model: "haiku" } },
        phases: [{ id: "clarify", questions: "elicitor", verify: "someOut", max_rounds: 5, out: "reqs" }],
      }).errors,
    ).toContain('phase "clarify": questions and verify are mutually exclusive');
  });

  // Step 0 (M1 review P2): raw phase in a group rejected (shares !phase.agent path)
  it("rejects a raw phase in a group", () => {
    const flow = {
      ...base,
      groups: { review: { phases: ["gate", "rawph"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "rawph", raw: "doStuff()" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'groups.review: phase "rawph" must be an agent phase (skill/raw/questions phases cannot participate in group loops)',
    );
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

  // S-15: loops become group-aware
  it("rejects until_dry on a group loop", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "fix", agent: "a", prompt: "f" },
      ],
      loops: { review: { until_dry: true, max_rounds: 3 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'loops.review: until_dry is not valid on a group loop (use until: approved)',
    );
  });
  it("rejects until:approved on group when gate agent lacks verdict schema", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku" } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "fix", agent: "a", prompt: "f" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      `loops.review: until:approved requires the gate phase's agent ("a") to declare a verdict schema`,
    );
  });
  it("rejects a loop on a questions phase", () => {
    const flow = {
      ...base,
      agents: { ...base.agents, elicitor: { model: "haiku" } },
      phases: [{ id: "clarify", questions: "elicitor", max_rounds: 5, out: "reqs" }],
      loops: { clarify: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect(validateFlowYaml(flow).errors).toContain(
      'loops.clarify: loops are not supported on questions phases (the follow-up loop is built-in)',
    );
  });
  it("group takes precedence on loop key collision (phase id == group name)", () => {
    const flow = {
      ...base,
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { gate: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "r" },
        { id: "fix", agent: "a", prompt: "f" },
      ],
      loops: { gate: { until_dry: true, max_rounds: 3 } },
    };
    // gate is both a phase id and a group name — group should take precedence
    // so until_dry is rejected (group loop rule), NOT treated as a phase-level loop
    expect(validateFlowYaml(flow).errors).toContain(
      'loops.gate: until_dry is not valid on a group loop (use until: approved)',
    );
  });
});

describe("contract graph validation", () => {
  const base = (phases: any[]) => ({
    name: "demo", description: "d", input: "prompt",
    agents: { a: {} }, phases,
  });

  it("rejects an unresolved inputs.require", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", inputs: { require: ["nope"] } },
    ]));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/unresolved/i);
  });

  it("accepts require that resolves to a prior publish", () => {
    const r = validateFlowYaml(base([
      { id: "p1", agent: "a", outputs: { publish: { foo: "value-1" } } },
      { id: "p2", agent: "a", inputs: { require: ["foo"] } },
    ]));
    expect(r.ok).toBe(true);
  });

  it("accepts require that resolves to the phase out shorthand", () => {
    const r = validateFlowYaml(base([
      { id: "p1", agent: "a", out: "doc" },
      { id: "p2", agent: "a", inputs: { require: ["doc"] } },
    ]));
    expect(r.ok).toBe(true);
  });

  it("accepts require on the built-in 'input'/'flow' without a publish", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", inputs: { require: ["input", "flow"] } },
    ]));
    expect(r.ok).toBe(true);
  });

  it("resurrects the in: shorthand as a require", () => {
    const r = validateFlowYaml(base([
      { id: "p1", agent: "a", out: "doc" },
      { id: "p2", agent: "a", in: "doc" },
    ]));
    expect(r.ok).toBe(true);
  });

  it("rejects worktree: finalize without a preceding prepare", () => {
    const r = validateFlowYaml(base([{ id: "f", agent: "a", worktree: "finalize" }]));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/finalize.*prepare/i);
  });

  it("accepts worktree: finalize after a prepare", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", worktree: "prepare" },
      { id: "f", agent: "a", worktree: "finalize" },
    ]));
    expect(r.ok).toBe(true);
  });

  it("rejects an unresolvable artifact template", () => {
    const r = validateFlowYaml(base([{
      id: "p", agent: "a",
      outputs: { slug: { from: "input" }, dir: "ai_plan/{{slug}}",
        artifacts: [{ file: "x.md", template: "@flow/plan/does-not-exist.md" }] },
    }]));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/not found/i);
  });

  it("rejects a publish name that is not a valid identifier", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", outputs: { publish: { "bad-name!": "{{slug}}" } } },
    ]));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/not a valid identifier/i);
  });

  it("rejects a bare-name publish value that does not resolve", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", outputs: { publish: { plan_dir: "mystery" } } },
    ]));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/not \{\{/i);
  });

  it("accepts a bare-name publish value equal to the phase out", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", out: "plan_doc", outputs: { publish: { plan_doc: "plan_doc" } } },
    ]));
    expect(r.ok).toBe(true);
  });

  it("accepts a literal (non-identifier) publish value", () => {
    const r = validateFlowYaml(base([
      { id: "p", agent: "a", outputs: { publish: { status: "all-done" } } },
    ]));
    expect(r.ok).toBe(true);
  });
});

describe("validateStrictProfile (ship-feature)", () => {
  const ship = (phases: any[]) => ({
    name: "ship-feature", description: "d", input: "prompt",
    agents: { a: {} }, phases,
  });

  it("is a no-op for a non-ship-feature flow", () => {
    expect(validateStrictProfile({ ...ship([{ id: "p", agent: "a" }]), name: "code-review" })).toEqual([]);
  });

  it("flags a ship-feature with no plan-artifact producer", () => {
    const errs = validateStrictProfile(ship([{ id: "plan", agent: "a" }]));
    expect(errs.join("\n")).toMatch(/no phase produces plan artifacts/i);
  });

  it("is satisfied when a plan phase produces artifacts and implement requires slug", () => {
    const errs = validateStrictProfile(ship([
      { id: "plan", agent: "a", outputs: { artifacts: [{ file: "milestone-plan.md" }] } },
      { id: "implement", agent: "a", inputs: { require: ["slug"] } },
    ]));
    expect(errs).toEqual([]);
  });

  it("flags an implement phase that does not require slug", () => {
    const errs = validateStrictProfile(ship([
      { id: "plan", agent: "a", outputs: { artifacts: [{ file: "milestone-plan.md" }] } },
      { id: "implement", agent: "a", inputs: { require: ["plan_dir"] } },
    ]));
    expect(errs.join("\n")).toMatch(/implement phase must require "slug"/i);
  });

  it("validateFlowYaml does not run the strict profile when no phase declares outputs", () => {
    // current (pre-migration) ship-feature has no outputs -> strict profile skipped
    const r = validateFlowYaml({
      name: "ship-feature", description: "d", input: "prompt",
      agents: { a: {} }, phases: [{ id: "plan", agent: "a", prompt: "p" }],
    });
    expect(r.errors).toEqual([]);
  });
});

describe("validateSection", () => {
  it("accepts valid agents section", () => {
    expect(validateSection("agents", { worker: { model: "haiku" } })).toEqual({ ok: true, errors: [] });
  });

  it("accepts valid phases section", () => {
    expect(validateSection("phases", [{ id: "p", agent: "a", prompt: "do", out: "o" }])).toEqual({ ok: true, errors: [] });
  });

  it("rejects agents section with invalid field", () => {
    const result = validateSection("agents", { worker: { bogus_field: true } });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/^agents\./);
  });

  it("accepts valid loops section (structural only)", () => {
    expect(validateSection("loops", { scan: { until_dry: true, max_rounds: 3 } })).toEqual({ ok: true, errors: [] });
  });

  it("rejects groups section with fewer than 2 phases (minItems)", () => {
    const result = validateSection("groups", { review: { phases: ["only-one"] } });
    expect(result.ok).toBe(false);
  });

  // PhaseDef doesn't enforce exactly one run-kind (agent/skill/raw) — that's a
  // cross-field rule handled by validateFlowYaml, not the structural schema.
  it("accepts a phase with only skill (structural — cross-field not enforced here)", () => {
    expect(validateSection("phases", [{ id: "p", agent: "a", skill: "sf-flow-plan" }])).toEqual({ ok: true, errors: [] });
  });
});
