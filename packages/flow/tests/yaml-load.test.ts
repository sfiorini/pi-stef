import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadFlowYaml, FlowYamlLoadError } from "../src/yaml/load.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

describe("loadFlowYaml — bundled workflows (regression)", () => {
  // Guard: loadFlowYaml must accept every shipped example workflow. The earlier
  // `Value.Cast` bug slipped through because tests used hand-written YAML, not
  // the real shipped files.
  it("loads every bundled example workflow without error", async () => {
    const dir = join(pkgRoot, "workflows");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const flow = await loadFlowYaml(join(dir, f));
      expect(flow.name, `${f} name`).toBeTruthy();
      expect(flow.phases.length, `${f} phases`).toBeGreaterThan(0);
    }
  });
});
