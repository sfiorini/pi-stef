import { describe, it, expect } from "vitest";
import { registerGeneratedFlow } from "../src/yaml/register.js";

describe("registerGeneratedFlow", () => {
  it("registers a /<name> command that delegates to sf_flow_auto", () => {
    const registered: { name: string; description: string; handler: (args: string) => Promise<string> }[] = [];
    const fakePi = {
      registerCommand: (name: string, opts: { description?: string; handler: (args: string) => Promise<string> }) => {
        registered.push({ name, description: opts.description ?? "", handler: opts.handler });
      },
    } as any;
    registerGeneratedFlow(fakePi, {
      name: "auth-audit",
      description: "d",
      input: "prompt",
      agents: {},
      phases: [{ id: "p", skill: "sf-flow-plan", out: "x" }],
    } as any);
    expect(registered[0].name).toBe("auth-audit");
    expect(registered[0].description).toBe("d");
  });

  it("generates eagerly so an invalid flow throws at registration", () => {
    const fakePi = { registerCommand: () => {} } as any;
    expect(() =>
      registerGeneratedFlow(fakePi, {
        name: "bad",
        description: "d",
        input: "prompt" as const,
        agents: {},
        phases: [{ id: "p", prompt: "no run kind" }], // no agent/skill/raw -> generator/validator gap surfaces
      } as any),
    ).toThrow();
  });
});
