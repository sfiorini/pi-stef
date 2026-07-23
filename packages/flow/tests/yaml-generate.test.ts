import { describe, it, expect } from "vitest";
import { generateScript } from "../src/yaml/generate.js";

const flow = {
  name: "auth-audit",
  description: "Audit auth",
  input: "prompt" as const,
  agents: {
    scanner: { tools: ["read", "grep", "find"], model: "haiku" },
    auditor: { model: "sonnet", schema: { verdict: "APPROVED|REVISE" } },
  },
  phases: [
    { id: "scan", agent: "scanner", prompt: "List routes.", out: "files" },
    { id: "audit", agent: "auditor", fanout: "files", prompt: "Audit {{item}}.", out: "findings" },
  ],
  loops: { audit: { until_dry: true, max_rounds: 3, dedup_key: "{{file}}" } },
};

describe("generateScript", () => {
  it("emits the meta header", () => {
    const s = generateScript(flow);
    expect(s).toContain("export const meta = {");
    expect(s).toContain("name: 'auth-audit'");
    expect(s).toContain("phases: [{ title: 'Scan' }, { title: 'Audit' }]");
  });
  it("uses agent() with agentType for each phase", () => {
    const s = generateScript(flow);
    expect(s).toMatch(/agentType:\s*['"]scanner['"]/);
    expect(s).toMatch(/agentType:\s*['"]auditor['"]/);
  });
  it("compiles fanout to parallel()", () => {
    const s = generateScript(flow);
    expect(s).toContain("parallel(");
    expect(s).toContain("files.map");
  });
  it("compiles until_dry loop to loopUntilDry", () => {
    const s = generateScript(flow);
    expect(s).toContain("loopUntilDry(");
  });
  it("is deterministic & idempotent", () => {
    const a = generateScript(flow);
    const b = generateScript(flow);
    expect(a).toBe(b);
  });

  it("resolves an undeclared reviewer phase to the built-in Reviewer agent", () => {
    const s = generateScript({ ...flow, agents: {}, phases: [{ id: "rev", agent: "reviewer", prompt: "Review it." }] });
    expect(s).toMatch(/agentType:\s*['"]Reviewer['"]/);
  });

  it("resolves an undeclared planner phase to the built-in Plan agent", () => {
    const s = generateScript({ ...flow, agents: {}, phases: [{ id: "plan", agent: "planner", prompt: "Plan it." }] });
    expect(s).toMatch(/agentType:\s*['"]Plan['"]/);
  });

  it("resolves any other undeclared agent to general-purpose", () => {
    const s = generateScript({ ...flow, agents: {}, phases: [{ id: "x", agent: "custom", prompt: "Do it." }] });
    expect(s).toMatch(/agentType:\s*['"]general-purpose['"]/);
  });

  it("a declared agent spawns by name (not the built-in fallback)", () => {
    const s = generateScript({ ...flow, agents: { reviewer: { model: "sonnet" } }, phases: [{ id: "rev", agent: "reviewer", prompt: "Review." }] });
    expect(s).toMatch(/agentType:\s*['"]reviewer['"]/);
  });
});

describe("generateScript skill-phase slug handoff + model hints (M5)", () => {
  const skillFlow = {
    name: "ship-feature",
    description: "d",
    input: "prompt" as const,
    agents: {},
    phases: [
      { id: "plan", skill: "sf-flow-plan" },
      { id: "implement", skill: "sf-flow-implement" },
      { id: "other", skill: "some-other-skill" },
    ],
  };
  const fullModels = {
    reviewerModel: "rev-model",
    researcherModel: "rs-model",
    developerModel: "dev-model",
    plannerModel: null,
    auditorModel: "aud-model",
    synthModel: null,
  };

  it("injects args.flow/args.slug into skill-phase prompts (no placeholder const)", () => {
    const s = generateScript(skillFlow);
    expect(s).toContain("args.slug");
    expect(s).toContain("args.flow");
    expect(s).not.toMatch(/const \w+ = "skill:/);
  });

  it("bakes the skill-relevant resolved model hint for tier-1 skills", () => {
    const s = generateScript(skillFlow, { models: fullModels });
    // plan phase gets reviewer + researcher
    expect(s).toContain("reviewer=rev-model");
    expect(s).toContain("researcher=rs-model");
    // implement phase gets reviewer + developer
    expect(s).toContain("developer=dev-model");
    // auditor is NOT hinted into plan/implement (only into sf-flow-audit)
    expect(s).not.toContain("auditor=aud-model");
  });

  it("omits the hint entirely (still compiles) when no models provided", () => {
    const s = generateScript(skillFlow);
    expect(s).toContain("sf-flow-plan");
    expect(s).toContain("some-other-skill");
    expect(s).not.toContain("reviewer=");
  });

  it("non-tier-1 skill names get NO model hint even when models are provided", () => {
    const s = generateScript(skillFlow, { models: fullModels });
    expect(s).toContain("some-other-skill");
    // the only hints are reviewer/researcher/developer (tier-1); 'some-other-skill'
    // itself contributes no hint line — confirm no auditor leaked anywhere
    expect(s).not.toContain("auditor=");
  });

  it("sf-flow-audit phase gets reviewer + auditor hints (no developer/researcher)", () => {
    const auditFlow = { ...skillFlow, phases: [{ id: "audit", skill: "sf-flow-audit" }] };
    const s = generateScript(auditFlow, { models: fullModels });
    expect(s).toContain("reviewer=rev-model");
    expect(s).toContain("auditor=aud-model");
    expect(s).not.toContain("developer=");
    expect(s).not.toContain("researcher=");
  });

  it("skill phases emit a log() INLINE directive, NOT a general-purpose twin", () => {
    const s = generateScript(skillFlow);
    expect(s).toContain("INLINE SKILL PHASE");
    expect(s).toContain("log(");
    expect(s).not.toMatch(/agentType:\s*['"]general-purpose['"]/);
  });

  it("the INLINE directive names the exact SKILL.md path for each skill phase", () => {
    const s = generateScript(skillFlow);
    expect(s).toContain("skills/sf-flow-plan/SKILL.md");
    expect(s).toContain("skills/sf-flow-implement/SKILL.md");
    expect(s).toContain("skills/some-other-skill/SKILL.md");
  });

  it("the INLINE directive tells the orchestrator to run inline (delegate, no twin, no code)", () => {
    const s = generateScript(skillFlow);
    expect(s).toContain("run it inline");
    expect(s).toContain("do NOT write code");
    expect(s).toContain("do NOT spawn a general-purpose subagent");
  });

  it("escapes backticks and ${ in baked-in values so the log() directive stays well-formed", () => {
    const tricky: FlowYaml = {
      name: "na`me${x}",
      description: "d",
      input: "prompt",
      agents: {},
      phases: [{ id: "p", skill: "sf-flow-plan" }],
      loops: {},
    };
    const s = generateScript(tricky);
    expect(s).toContain("INLINE SKILL PHASE");
    // flow.name's backtick + ${ must be backslash-escaped in the emitted source
    const escaped = "na" + "\\" + "`" + "me" + "\\" + "${" + "x}";
    expect(s).toContain(escaped);
    // the runtime interpolations must NOT be escaped (still literal ${args.flow})
    expect(s).toContain("${args.flow}");
    expect(s).toContain("${args.slug}");
  });
});
