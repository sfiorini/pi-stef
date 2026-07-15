import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { validateFlowYaml } from "../src/yaml/validate.js";
import { generateScript } from "../src/yaml/generate.js";
import type { FlowYaml } from "../src/yaml/schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = ["auth-audit", "ship-feature", "code-review", "research-report"];

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
});
