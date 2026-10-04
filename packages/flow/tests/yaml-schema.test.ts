import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  FlowYamlSchema,
  PhaseDef,
  LoopDef,
  GroupDef,
  ArtifactSpec,
  SlugSpec,
  PhaseInputs,
  PhaseOutputs,
} from "../src/yaml/schema.js";

const valid = {
  name: "auth-audit",
  description: "Audit auth",
  input: "prompt",
  agents: ["scanner"],
  phases: [{ id: "scan", agent: "scanner", prompt: "list routes", out: "files" }],
  loops: { scan: { until_dry: true, max_rounds: 3 } },
};

describe("flow yaml schema", () => {
  it("accepts a valid flow", () => {
    expect([...Value.Errors(FlowYamlSchema, valid)]).toHaveLength(0);
  });
  it("rejects unknown input type", () => {
    expect([...Value.Errors(FlowYamlSchema, { ...valid, input: "bogus" })].length).toBeGreaterThan(0);
  });
  it("rejects the OLD agents-as-map shape (agents must be a list of names)", () => {
    const flow = {
      ...valid,
      agents: { scanner: { tools: ["read"], model: "haiku" } },
    };
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });
  it("rejects non-string agents entries", () => {
    expect([...Value.Errors(FlowYamlSchema, { ...valid, agents: ["ok", 42] })].length).toBeGreaterThan(0);
  });
  it("accepts a questions phase with max_rounds + phase schema", () => {
    const flow = {
      ...valid,
      agents: ["elicitor"],
      phases: [{ id: "clarify", questions: "elicitor", schema: { questions: "array" }, max_rounds: 5, out: "reqs" }],
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });
  it("accepts a groups map (gate schema on the gate phase)", () => {
    const flow = {
      name: "review-loop",
      description: "audit then fix",
      input: "prompt",
      agents: ["auditor", "developer"],
      groups: { review: { phases: ["review", "fix"] } },
      phases: [
        { id: "review", agent: "auditor", schema: { verdict: "APPROVED|REVISE" }, prompt: "audit" },
        { id: "fix", agent: "developer", prompt: "fix" },
      ],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });
  it("rejects a group with fewer than 2 phases", () => {
    const flow = {
      name: "review-loop",
      description: "audit then fix",
      input: "prompt",
      agents: ["auditor"],
      groups: { review: { phases: ["review"] } },
      phases: [{ id: "review", agent: "auditor", prompt: "audit" }],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });

  it("exports PhaseDef/LoopDef/GroupDef with .properties (AgentDef is deleted)", () => {
    for (const def of [PhaseDef, LoopDef, GroupDef]) {
      expect(def).toBeDefined();
      expect(def.properties).toBeDefined();
      expect(typeof def.properties).toBe("object");
    }
    // AgentDef no longer exists — the workflow YAML carries only agent NAMES.
    expect((PhaseDef as any).properties).toHaveProperty("schema");
  });

  it("PhaseDef.schema accepts a verdict/findings contract", () => {
    expect([...Value.Errors(PhaseDef, { id: "gate", agent: "reviewer", schema: { verdict: "APPROVED|REVISE", findings: "array" } })]).toHaveLength(0);
    expect([...Value.Errors(PhaseDef, { id: "x", agent: "a", schema: { bogus: { nested: true } } })]).toHaveLength(0);
  });
});

describe("PhaseDef contracts", () => {
  it("accepts a phase with inputs/outputs/worktree", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt",
      agents: ["planner"],
      phases: [{
        id: "plan", agent: "planner",
        inputs: { require: ["design_doc"], inject: ["Design: {{design_doc}}"] },
        outputs: {
          slug: { from: "input", prefix: "date" },
          dir: "ai_plan/{{slug}}",
          artifacts: [{ file: "milestone-plan.md", template: "@flow/plan/milestone-plan.md" }],
          assert: ["nonempty"],
          publish: { slug: "{{slug}}", plan_dir: "{{dir}}" },
        },
        worktree: "none",
      }],
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });

  it("rejects unknown worktree value", () => {
    const flow = { name: "demo", description: "d", input: "prompt", agents: ["p"],
      phases: [{ id: "p", agent: "p", worktree: "maybe" }] };
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });

  it("exports the contract sub-schemas with .properties", () => {
    for (const def of [ArtifactSpec, SlugSpec, PhaseInputs, PhaseOutputs]) {
      expect(def).toBeDefined();
      expect(def.properties).toBeDefined();
      expect(typeof def.properties).toBe("object");
    }
  });

  it("rejects a publish value that is not a string", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: ["p"],
      phases: [{ id: "p", agent: "p", outputs: { publish: { slug: 123 } } }],
    } as any;
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });

  it("accepts an artifact without a template (write-empty)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: ["p"],
      phases: [{ id: "p", agent: "p", outputs: { dir: "ai_plan/{{slug}}", artifacts: [{ file: "x.md" }] } }],
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });
});
