import { describe, it, expect } from "vitest";
import { writeFlowYaml, writeFlowYamlAsync } from "../src/yaml/write.js";
import { validateFlowYaml } from "../src/yaml/validate.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "js-yaml";
import type { FlowYaml } from "../src/yaml/schema.js";

describe("writeFlowYaml", () => {
  it("writes a valid yaml the validator accepts and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-cw-"));
    const flow: FlowYaml = {
      name: "demo",
      description: "d",
      input: "prompt",
      agents: { a: { model: "haiku" } },
      phases: [{ id: "p", agent: "a", prompt: "do", out: "o" }],
    };
    const path = writeFlowYaml(dir, flow);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("name: demo");
    // round-trip: re-parse and re-validate
    const reparsed = load(raw) as FlowYaml;
    expect(validateFlowYaml(reparsed).ok).toBe(true);
    expect(reparsed.name).toBe("demo");
  });

  it("places the file at <dir>/<name>.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-cw-"));
    const path = writeFlowYaml(dir, {
      name: "ship-feature",
      description: "d",
      input: "prompt",
      agents: { a: { model: "haiku" } },
      phases: [{ id: "p", agent: "a", prompt: "do", out: "o" }],
    });
    expect(path).toBe(join(dir, "ship-feature.yaml"));
  });

  it("writeFlowYamlAsync writes the file and returns the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-cw-async-"));
    const path = await writeFlowYamlAsync(dir, {
      name: "async-demo",
      description: "d",
      input: "prompt",
      agents: { a: { model: "haiku" } },
      phases: [{ id: "p", agent: "a", prompt: "do", out: "o" }],
    });
    expect(path).toBe(join(dir, "async-demo.yaml"));
    expect(readFileSync(path, "utf8")).toContain("name: async-demo");
  });
});
