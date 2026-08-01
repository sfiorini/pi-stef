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

  it("tier-2 agent phase bakes YAML model verbatim; config never overrides it", () => {
    const s = generateScript({
      name: "t", description: "d", input: "prompt",
      agents: { scanner: { model: "haiku" } },
      phases: [{ id: "scan", agent: "scanner", prompt: "go" }],
    });
    expect(s).toMatch(/model:\s*"haiku"/);
    const s2 = generateScript({
      name: "t", description: "d", input: "prompt",
      agents: { scanner: { model: "haiku" } },
      phases: [{ id: "scan", agent: "scanner", prompt: "go" }],
    }, { models: { reviewerModel: "config-rev", researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null } });
    expect(s2).not.toContain("config-rev");
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

  // S-21: pre-scan phaseToGroup + questions branch
  it("emits QUESTIONS PHASE directive for a questions phase", () => {
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { elicitor: { model: "haiku", thinking: "high", isolated: true, schema: { questions: "array" } } },
      phases: [{ id: "clarify", questions: "elicitor", max_rounds: 5, out: "reqs" }],
    };
    const s = generateScript(qFlow);
    expect(s).toContain("QUESTIONS PHASE: elicitor");
    expect(s).toContain("max 5 rounds");
    expect(s).toContain("AskUserQuestion");
    expect(s).toContain("sensible defaults");
    expect(s).toContain('phase("clarify")');
  });

  it("defaults max_rounds to 5 when omitted", () => {
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { elicitor: { model: "haiku" } },
      phases: [{ id: "clarify", questions: "elicitor", out: "reqs" }],
    };
    const s = generateScript(qFlow);
    expect(s).toContain("max 5 rounds");
  });

  it("questions branch is deterministic and idempotent", () => {
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { elicitor: { model: "haiku", thinking: "high", isolated: true, schema: { questions: "array" } } },
      phases: [{ id: "clarify", questions: "elicitor", max_rounds: 3, out: "reqs" }],
    };
    const a = generateScript(qFlow);
    const b = generateScript(qFlow);
    expect(a).toBe(b);
  });

  it("mentions args.flow and args.slug in the QUESTIONS PHASE directive", () => {
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { elicitor: { model: "haiku" } },
      phases: [{ id: "clarify", questions: "elicitor", out: "reqs" }],
    };
    const s = generateScript(qFlow);
    expect(s).toContain("${args.flow}");
    expect(s).toContain("${args.slug}");
  });

  it("grouped phases are skipped (group emitted once, individual phases suppressed)", () => {
    const gFlow: FlowYaml = {
      name: "g", description: "d", input: "prompt",
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "review" },
        { id: "fix", agent: "a", prompt: "fix" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    const s = generateScript(gFlow);
    // group phase emitted
    expect(s).toContain('phase("review")');
    // individual phases are suppressed (not emitted separately)
    expect(s).not.toContain('phase("gate")');
    expect(s).not.toContain('phase("fix")');
  });

  // S-22: emitGroupLoop helper tests
  describe("emitGroupLoop (group loops)", () => {
    const groupFlow: FlowYaml = {
      name: "g", description: "d", input: "prompt",
      agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
      groups: { review: { phases: ["gate", "fix"] } },
      phases: [
        { id: "gate", agent: "a", prompt: "review it" },
        { id: "fix", agent: "a", prompt: "fix it" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0", "P1", "P2"], max_rounds: 5 } },
    };

    it("emits phase(\"<g>\") for the group", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain('phase("review")');
    });

    it("emits for (let _round = _maxRounds", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain("for (let _round");
      expect(s).toContain("_maxRounds");
    });

    it("gate verdict APPROVED check + blocking findings filter (F1 guarded form)", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain('_gate?.verdict === "APPROVED"');
      expect(s).toContain('_findings.filter');
      expect(s).toContain("_blocking");
      // F1 invariant: null gate must NOT be treated as approval
      expect(s).toContain("(_gate && _blocking.length === 0)");
      expect(s).not.toContain("|| _blocking.length === 0) {");
    });

    it("emits _findingsJson + Canonical findings to address", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain("_findingsJson");
      expect(s).toContain("Canonical findings to address");
    });

    it("emits NON-CONVERGENT log on exhaustion", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain("NON-CONVERGENT");
    });

    it("does NOT emit individual phase(\"gate\")/phase(\"fix\") for grouped phases", () => {
      const s = generateScript(groupFlow);
      expect(s).not.toContain('phase("gate")');
      expect(s).not.toContain('phase("fix")');
    });

    it("deterministic and idempotent", () => {
      const a = generateScript(groupFlow);
      const b = generateScript(groupFlow);
      expect(a).toBe(b);
    });
  });

  // S-23: multi-group no-collision test
  describe("multi-group no-collision", () => {
    it("two groups get separate block scopes with no variable collision", () => {
      const multiFlow: FlowYaml = {
        name: "mg", description: "d", input: "prompt",
        agents: { a: { model: "haiku", schema: { verdict: "APPROVED|REVISE" } } },
        groups: {
          loop1: { phases: ["g1", "f1"] },
          loop2: { phases: ["g2", "f2"] },
        },
        phases: [
          { id: "g1", agent: "a", prompt: "review 1" },
          { id: "f1", agent: "a", prompt: "fix 1" },
          { id: "g2", agent: "a", prompt: "review 2" },
          { id: "f2", agent: "a", prompt: "fix 2" },
        ],
        loops: {
          loop1: { until: "approved", fail_on: ["P0"], max_rounds: 5 },
          loop2: { until: "approved", fail_on: ["P0"], max_rounds: 3 },
        },
      };
      const s = generateScript(multiFlow);
      // Two separate _maxRounds declarations (one per group)
      expect(s.match(/const _maxRounds/g)?.length).toBe(2);
      // Group phases emitted
      expect(s).toContain('phase("loop1")');
      expect(s).toContain('phase("loop2")');
      // Individual phases are suppressed
      expect(s).not.toContain('phase("g1")');
      expect(s).not.toContain('phase("g2")');
      expect(s).not.toContain('phase("f1")');
      expect(s).not.toContain('phase("f2")');
    });
  });
});
