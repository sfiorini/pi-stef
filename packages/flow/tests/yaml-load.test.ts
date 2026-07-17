import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFlowYaml, FlowYamlLoadError } from "../src/yaml/load.js";

const VALID = `name: demo
description: demo flow
input: prompt
agents:
  worker: {}
phases:
  - id: do
    agent: worker
`;

function writeTmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-load-"));
  const file = join(dir, "flow.yaml");
  writeFileSync(file, content, "utf8");
  return file;
}

describe("loadFlowYaml", () => {
  it("parses + validates a well-formed workflow", async () => {
    const flow = await loadFlowYaml(writeTmp(VALID));
    expect(flow.name).toBe("demo");
    expect(flow.phases).toHaveLength(1);
    expect(flow.phases[0].agent).toBe("worker");
  });

  it("rejects a structurally invalid flow (empty phases -> minItems)", async () => {
    const file = writeTmp(`name: bad\ndescription: d\ninput: prompt\nagents: {}\nphases: []\n`);
    await expect(loadFlowYaml(file)).rejects.toBeInstanceOf(FlowYamlLoadError);
  });

  it("rejects a reserved flow name (sf-flow- prefix)", async () => {
    const file = writeTmp(VALID.replace("name: demo", "name: sf-flow-evil"));
    await expect(loadFlowYaml(file)).rejects.toThrow(/reserved/i);
  });

  it("wraps a YAML parse error in FlowYamlLoadError", async () => {
    const file = writeTmp("name: : :\n  [unclosed");
    await expect(loadFlowYaml(file)).rejects.toBeInstanceOf(FlowYamlLoadError);
  });
});
