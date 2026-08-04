import { describe, it, expect } from "vitest";
import { generateScript } from "../src/yaml/generate.js";
import { validateFlowYaml } from "../src/yaml/validate.js";

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
    }, { models: { reviewerModel: "config-rev", researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: null, notifierModel: null, scannerModel: null } });
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
    designerModel: null,
    elicitorModel: null,
    notifierModel: null,
    scannerModel: null,
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

  it("escapes dangerous chars in agent name for questions-phase directive (P2-1)", () => {
    // Agent key with backtick and ${ — would break template literal if unescaped
    const dangerousKey = "my`bot${1}";
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { [dangerousKey]: { model: "haiku" } },
      phases: [{ id: "clarify", questions: dangerousKey, out: "reqs" }],
    };
    // Must not throw — generation succeeds
    const s = generateScript(qFlow);
    // Directive still present
    expect(s).toContain("QUESTIONS PHASE");
    // The dangerous agent name appears ESCAPED (backslash-backtick, backslash-${) in the directive
    expect(s).toContain("my\\`bot\\${1}");
    // CRITICAL: the subagent_type value in the directive must also be escaped
    // (otherwise the raw backtick in qAgentType would break the template literal)
    expect(s).toContain("subagent_type: my\\`bot\\${1}");
    // The opts line still has the raw value in the comment (not in the directive)
    expect(s).toContain("// elicitor agent opts:");
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

    it("gate routes through the shared fail-closed _gateApproved (D4)", () => {
      const s = generateScript(groupFlow);
      expect(s).toMatch(/_gateApproved\(_gate\s*,\s*_failOn\)/);
      expect(s).toContain("_findings.filter");
      expect(s).toContain("_blocking"); // still emitted for the NON-CONVERGENT log
      // F1/D4 invariant: the permissive OR-tail is gone; null/{} gate can never approve
      expect(s).not.toContain("(_gate && _blocking.length === 0)");
      expect(s).not.toContain('verdict === "APPROVED" ||');
    });

    it("emits the _gateApproved helper once for a gated workflow", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain("function _gateApproved(");
      expect(s.match(/function _gateApproved\(/g)).toHaveLength(1);
    });

    it("non-convergence returns a blocked terminal (not approval)", () => {
      const s = generateScript(groupFlow);
      expect(s).toContain("NON-CONVERGENT");
      expect(s).toMatch(/status:\s*"blocked"/);
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

  describe("questions-phase elicitor config fallback (M2)", () => {
    it("questions-phase bakes elicitorModel from config when no inline model", () => {
      const qFlow: FlowYaml = {
        name: "q", description: "d", input: "prompt",
        agents: { elicitor: { schema: { questions: "array" } } },
        phases: [{ id: "clarify", questions: "elicitor", max_rounds: 3, out: "reqs" }],
      };
      const models = { reviewerModel: null, researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: "config/el", notifierModel: null, scannerModel: null };
      const s = generateScript(qFlow, { models });
      expect(s).toMatch(/model:\s*"config\/el"/);
    });

    it("inline YAML model wins over elicitorModel config", () => {
      const qFlow: FlowYaml = {
        name: "q", description: "d", input: "prompt",
        agents: { elicitor: { model: "yaml-el", schema: { questions: "array" } } },
        phases: [{ id: "clarify", questions: "elicitor", max_rounds: 3, out: "reqs" }],
      };
      const models = { reviewerModel: null, researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: "config/el", notifierModel: null, scannerModel: null };
      const s = generateScript(qFlow, { models });
      expect(s).toMatch(/model:\s*"yaml-el"/);
      expect(s).not.toContain("config/el");
    });

    it("no model when both inline and config are absent", () => {
      const qFlow: FlowYaml = {
        name: "q", description: "d", input: "prompt",
        agents: { elicitor: { schema: { questions: "array" } } },
        phases: [{ id: "clarify", questions: "elicitor", max_rounds: 3, out: "reqs" }],
      };
      const s = generateScript(qFlow);
      expect(s).not.toMatch(/model:\s*"[^"]+"/);
    });

    it("non-questions tier-2 agent does NOT pick up elicitorModel", () => {
      const flow: FlowYaml = {
        name: "t", description: "d", input: "prompt",
        agents: { scanner: {} },
        phases: [{ id: "scan", agent: "scanner", prompt: "go" }],
      };
      const models = { reviewerModel: null, researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: "config/el", notifierModel: null, scannerModel: null };
      const s = generateScript(flow, { models });
      expect(s).not.toContain("config/el");
    });
  });
});

describe("tier-2 agent config fallback (M6)", () => {
  const withScanner = { reviewerModel: null, researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: null, notifierModel: null, scannerModel: "config/sc" };
  const withReviewer = { reviewerModel: "config/rev", researcherModel: null, developerModel: null, plannerModel: null, auditorModel: null, synthModel: null, designerModel: null, elicitorModel: null, notifierModel: null, scannerModel: null };
  const flow = (agents: Record<string, { model?: string }>, agent: string) => ({ name: "t", description: "d", input: "prompt" as const, agents, phases: [{ id: "p", agent, prompt: "go" }] });
  it("(a) config + no inline → emits config model", () => { expect(generateScript(flow({ scanner: {} }, "scanner"), { models: withScanner })).toMatch(/model:\s*"config\/sc"/); });
  it("(b) inline wins over config", () => { const s = generateScript(flow({ scanner: { model: "yaml/sc" } }, "scanner"), { models: withScanner }); expect(s).toMatch(/model:\s*"yaml\/sc"/); expect(s).not.toContain("config/sc"); });
  it("(c) neither → no model emitted", () => { expect(generateScript(flow({ scanner: {} }, "scanner"))).not.toMatch(/model:\s*"[^"]+"/) });
  it("(c2) models=null → no model", () => { expect(generateScript(flow({ scanner: {} }, "scanner"), { models: null })).not.toMatch(/model:\s*"[^"]+"/); });
  it("(d) group-loop gate+fix with config → 2 matches", () => {
    const g = { name: "g", description: "d", input: "prompt" as const, agents: { reviewer: { schema: { verdict: "APPROVED|REVISE" } }, developer: {} }, groups: { review: { phases: ["gate", "fix"] } }, phases: [{ id: "gate", agent: "reviewer", prompt: "r" }, { id: "fix", agent: "reviewer", prompt: "f" }], loops: { review: { until: "approved" as const, fail_on: ["P0"], max_rounds: 5 } } };
    const s = generateScript(g, { models: withReviewer });
    expect(s.match(/model:\s*"config\/rev"/g)).toHaveLength(2);
  });
  it("case-insensitive agent name", () => { expect(generateScript(flow({ Scanner: {} }, "Scanner"), { models: withScanner })).toMatch(/model:\s*"config\/sc"/); });

  it("(e) single-phase gate routes through _gateApproved (D4, no permissive tail)", () => {
    const g: FlowYaml = {
      name: "sg", description: "d", input: "prompt",
      agents: { reviewer: { schema: { verdict: "APPROVED|REVISE" } } },
      phases: [{ id: "rev", agent: "reviewer", prompt: "review", out: "verdict" }],
      loops: { rev: { until: "approved", fail_on: ["P0"], max_rounds: 3 } },
    };
    const s = generateScript(g);
    expect(s).toContain("function _gateApproved(");
    expect(s).toMatch(/_gateApproved\(r\s*,\s*\[/);
    // the old permissive `blocking.length === 0 ? { ok: true }` tail is gone
    expect(s).not.toContain("blocking.length === 0 ? { ok: true }");
  });
});

describe("generateScript contract envelope (M3)", () => {
  it("emits the contract envelope with destructured inputs + resolved placeholders (S-M3-2)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt",
      agents: { planner: {} },
      phases: [{
        id: "plan", agent: "planner", out: "plan_doc",
        prompt: "Produce the plan.",
        inputs: { require: ["design_doc"], inject: ["D: {{design_doc}}"] },
        outputs: {
          slug: { from: "input", prefix: "date" },
          dir: "ai_plan/{{slug}}",
          artifacts: [{ file: "milestone-plan.md", template: "@flow/plan/milestone-plan.md" }],
          assert: ["nonempty"],
          publish: { slug: "{{slug}}", plan_dir: "{{dir}}", plan_doc: "plan_doc" },
        },
      }],
    };
    const s = generateScript(flow as any);
    expect(s).toContain('"load-required"');          // loadRequired emitted
    expect(s).toContain("const design_doc = _req");  // loaded value DESTRUCTURED into a JS const
    expect(s).toContain('"derive-slug"');
    expect(s).toContain('"materialize"');
    expect(s).toContain('"assert"');
    expect(s).toContain('"complete"');          // one atomic publish+mark+persist call per phase
    expect(s).toContain("ai_plan/${args.slug}"); // checkpoint state dir uses the run-level slug
    expect(s).toContain("_assertRes");          // assert result is captured + guarded
    // inject resolves {{design_doc}} to a JS ref, not a literal placeholder:
    expect(s).toMatch(/\$\{design_doc\}/);
    expect(s).not.toMatch(/"\{\{design_doc\}\}"/);
    // publish resolves {{slug}}/{{dir}} to JS identifiers, not literal strings:
    expect(s).toMatch(/slug:\s*slug/);
    expect(s).toMatch(/plan_dir:\s*_dir/);
    expect(s).not.toMatch(/"\{\{slug\}\}"/);
  });

  it("resurrects the dead in: shorthand by destructuring + injecting the value (S-M3-2)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [
        { id: "p1", agent: "a", out: "doc", prompt: "make doc" },
        { id: "p2", agent: "a", in: "doc", prompt: "use doc" },
      ],
    };
    const s = generateScript(flow as any);
    expect(s).toContain("const doc = _req");   // p2 loads + destructures doc
    expect(s).toMatch(/\$\{doc\}/);            // and interpolates it into the prompt
  });

  it("phases without contracts emit no prologue noise but still complete (resume marker)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [{ id: "p", agent: "a", prompt: "go" }],
    };
    const s = generateScript(flow as any);
    expect(s).not.toContain('"load-required"');
    expect(s).not.toContain('"derive-slug"');
    expect(s).toContain('"complete"'); // marks the phase success for resume
  });

  it("a blocked load-required returns a blocked terminal naming the phase", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [{ id: "p", agent: "a", inputs: { require: ["missing"] }, prompt: "go" }],
    };
    const s = generateScript(flow as any);
    expect(s).toContain('status: "blocked"');
    expect(s).toContain('finalPhase: "p"');
  });

  it("skill phase emits the assert envelope around the INLINE directive (S-M3-3)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: {},
      phases: [{
        id: "plan", skill: "sf-flow-plan",
        outputs: {
          slug: { from: "input" }, dir: "ai_plan/{{slug}}",
          artifacts: [{ file: "milestone-plan.md", template: "@flow/plan/milestone-plan.md" }],
          assert: ["nonempty"],
          publish: { slug: "{{slug}}" },
        },
      }],
    };
    const s = generateScript(flow as any);
    expect(s).toContain("INLINE SKILL PHASE");
    expect(s).toContain('"assert"'); // sf_flow_contract assert envelope emitted
    expect(s).toContain('"complete"');
  });

  it("emits a structured terminal result reading load-all (S-M3-4)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [{ id: "p", agent: "a", prompt: "go" }],
    };
    const s = generateScript(flow as any);
    expect(s).toContain('"load-all"');
    expect(s).toMatch(/status:\s*_final\.details\?\.blockedPhase/);
    expect(s).toMatch(/finalPhase:/);
    expect(s).toMatch(/resumeState:/);
    // the old bare `return { name: "x" };` (name as the only field) is gone — the
    // structured return always has a comma after name (status, finalPhase, …)
    expect(s).not.toMatch(/return \{ name:[^,]*\};\s*$/);
  });

  it("worktree:prepare publishes the handle; worktree:finalize recovers it", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [
        { id: "impl", agent: "a", worktree: "prepare", prompt: "build", out: "impl_result",
          outputs: { publish: { impl_result: "impl_result" } } },
        { id: "fin", agent: "a", worktree: "finalize", prompt: "done" },
      ],
    };
    const s = generateScript(flow as any);
    expect(s).toContain("sf_flow_prepare({ slug: args.slug })");
    expect(s).toContain("worktreePath: _wt?.worktreePath");
    expect(s).toContain('require: ["worktreePath"]');
    expect(s).toContain("sf_flow_finalize(");
  });

  it("questions/skill phases with out but no publish do NOT auto-publish an undefined ref (M3 P2)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt",
      agents: { elicitor: { model: "haiku" } },
      phases: [{ id: "clarify", questions: "elicitor", out: "reqs", max_rounds: 3 }],
    };
    const s = generateScript(flow as any);
    // the epilogue completes the phase (marks success) but must NOT reference `reqs`
    // (questions phases emit a directive, no `const reqs = …`).
    expect(s).toContain('"complete"');
    expect(s).not.toMatch(/outputs:\s*\{[^}]*reqs:/);
  });

  it("empty complete emits outputs: {} (no stray identifier)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { a: {} },
      phases: [{ id: "p", agent: "a", prompt: "go" }],
    };
    const s = generateScript(flow as any);
    expect(s).toContain("outputs: {}");
    expect(s).not.toContain("outputs: {  }");
  });
});

describe("notifier agent phase (Tier-2 send mechanism)", () => {
  const notifierFlow = {
    name: "ping", description: "notify on done", input: "prompt" as const,
    agents: { notifier: { tools: ["bash"], thinking: "low", isolated: true,
      schema: { status: "sent|skipped|failed", detail: "string?" } } },
    phases: [{ id: "notify", agent: "notifier", prompt: "Flow complete", out: "notify_result" }],
  };

  it("validates cleanly", () => {
    const result = validateFlowYaml(notifierFlow);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("generates agentType, tools, isolated, thinking", () => {
    const s = generateScript(notifierFlow);
    expect(s).toMatch(/agentType:\s*["']notifier["']/);
    expect(s).toContain('["bash"]');
    expect(s).toContain('isolated: true');
    expect(s).toMatch(/thinking:\s*["']low["']/);
  });

  it("emits the status schema verbatim", () => {
    const s = generateScript(notifierFlow);
    expect(s).toContain("sent|skipped|failed");
  });

  it("emits plain await agent() with no loopUntilDry/parallel/gate", () => {
    const s = generateScript(notifierFlow);
    expect(s).toContain("await agent(");
    expect(s).not.toContain("loopUntilDry(");
    expect(s).not.toContain("parallel(");
    expect(s).not.toContain("gate(");
  });

  it("bakes static prompt verbatim + const notify_result =", () => {
    const s = generateScript(notifierFlow);
    expect(s).toContain("Flow complete");
    expect(s).toMatch(/const notify_result\s*=/);
  });

  it("is deterministic", () => {
    expect(generateScript(notifierFlow)).toBe(generateScript(notifierFlow));
  });
});
