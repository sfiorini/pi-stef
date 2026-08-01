import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { FlowYamlSchema } from "../src/yaml/schema.js";

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
});
