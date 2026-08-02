import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { FlowYamlSchema, AgentDef, PhaseDef, LoopDef, GroupDef } from "../src/yaml/schema.js";

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
