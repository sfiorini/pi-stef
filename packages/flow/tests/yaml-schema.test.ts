import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  FlowYamlSchema,
  AgentDef,
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
  agents: { scanner: { tools: ["read", "grep", "find"], model: "haiku" } },
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
  it("accepts a questions phase with max_rounds", () => {
    const flow = {
      ...valid,
      agents: {
        ...valid.agents,
        elicitor: { tools: ["read"], thinking: "high", isolated: true },
      },
      phases: [{ id: "clarify", questions: "elicitor", max_rounds: 5, out: "reqs" }],
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });
  it("accepts a groups map", () => {
    const flow = {
      name: "review-loop",
      description: "audit then fix",
      input: "prompt",
      agents: {
        auditor: { tools: ["read"], model: "sonnet", schema: { verdict: "APPROVED|REVISE" } },
        developer: { tools: ["read", "write"], model: "sonnet" },
      },
      groups: { review: { phases: ["review", "fix"] } },
      phases: [
        { id: "review", agent: "auditor", prompt: "audit" },
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
      agents: {
        auditor: { tools: ["read"], model: "sonnet" },
      },
      groups: { review: { phases: ["review"] } },
      phases: [{ id: "review", agent: "auditor", prompt: "audit" }],
      loops: { review: { until: "approved", fail_on: ["P0"], max_rounds: 5 } },
    };
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });

  it("exports AgentDef, PhaseDef, LoopDef, GroupDef with .properties", () => {
    for (const def of [AgentDef, PhaseDef, LoopDef, GroupDef]) {
      expect(def).toBeDefined();
      expect(def.properties).toBeDefined();
      expect(typeof def.properties).toBe("object");
    }
  });
});

describe("PhaseDef contracts", () => {
  it("accepts a phase with inputs/outputs/worktree", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt",
      agents: { planner: {} },
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
    const flow = { name: "demo", description: "d", input: "prompt", agents: { p: {} },
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
      name: "demo", description: "d", input: "prompt", agents: { p: {} },
      phases: [{ id: "p", agent: "p", outputs: { publish: { slug: 123 } } }],
    } as any;
    expect([...Value.Errors(FlowYamlSchema, flow)].length).toBeGreaterThan(0);
  });

  it("accepts an artifact without a template (write-empty)", () => {
    const flow = {
      name: "demo", description: "d", input: "prompt", agents: { p: {} },
      phases: [{ id: "p", agent: "p", outputs: { dir: "ai_plan/{{slug}}", artifacts: [{ file: "x.md" }] } }],
    };
    expect([...Value.Errors(FlowYamlSchema, flow)]).toHaveLength(0);
  });
});
