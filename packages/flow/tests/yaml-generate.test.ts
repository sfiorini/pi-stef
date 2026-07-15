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
});
