import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { validateFlowYaml } from "../src/yaml/validate.js";
import { generateScript } from "../src/yaml/generate.js";
import type { FlowYaml } from "../src/yaml/schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = ["auth-audit", "ship-feature", "code-review", "research-report", "deep-research"];

describe("bundled example workflows", () => {
  for (const name of EXAMPLES) {
    it(`${name}.yaml validates and generates`, () => {
      const raw = readFileSync(join(pkgRoot, "workflows", `${name}.yaml`), "utf8");
      const flow = load(raw) as FlowYaml;
      const result = validateFlowYaml(flow);
      expect(result.ok, result.errors.join("; ")).toBe(true);
      // generation is deterministic + must not throw
      expect(generateScript(flow)).toBe(generateScript(flow));
    });
  }

  it("ship-feature generates the contract steps (derive-slug/materialize/assert + prepare/finalize)", () => {
    const raw = readFileSync(join(pkgRoot, "workflows", "ship-feature.yaml"), "utf8");
    const flow = load(raw) as FlowYaml;
    const s = generateScript(flow);
    expect(s).toContain('"derive-slug"');
    expect(s).toContain('"materialize"');
    expect(s).toContain('"assert"');
    expect(s).toContain('"complete"');
    expect(s).toContain("sf_flow_prepare("); // implement phase worktree:prepare
    expect(s).toContain("sf_flow_finalize("); // notify phase worktree:finalize
    expect(s).toContain('"tracker_updated"'); // implement asserts the tracker advanced
    expect(s).toContain("let _canonical"); // audit-loop is canonical-delta
  });

  it("code-review generates the canonical-delta machinery", () => {
    const raw = readFileSync(join(pkgRoot, "workflows", "code-review.yaml"), "utf8");
    const flow = load(raw) as FlowYaml;
    const s = generateScript(flow);
    expect(s).toContain("sf_flow_gate(");
    expect(s).toContain('"canonical-round"');
  });
});
