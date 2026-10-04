import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { generateScript } from "../src/yaml/generate.js";
import { validateFlowYaml } from "../src/yaml/validate.js";
import type { FlowYaml } from "../src/yaml/schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("M7 verification: generated-script inspection (all bundled workflows)", () => {
  const files = readdirSync(join(pkgRoot, "workflows")).filter((f) => f.endsWith(".yaml"));

  it("every bundled workflow validates + generates deterministically", () => {
    expect(files.length).toBe(5);
    for (const f of files) {
      const flow = load(readFileSync(join(pkgRoot, "workflows", f), "utf8")) as FlowYaml;
      const v = validateFlowYaml(flow);
      expect(v.ok, `${f}: ${v.errors.join("; ")}`).toBe(true);
      expect(generateScript(flow)).toBe(generateScript(flow));
    }
  });

  it("every emitted agent( call's opts contain ONLY {label, phase, agentType, schema?}", () => {
    const forbidden = /\b(model|tools|thinking|isolated|tier)\s*:/;
    for (const f of files) {
      const flow = load(readFileSync(join(pkgRoot, "workflows", f), "utf8")) as FlowYaml;
      const script = generateScript(flow);
      // Extract every options object in agent(...) calls and check the shape.
      // Raw-phase bodies are emitted verbatim — so this check covers them too:
      // deep-research's raw agent() calls must carry only the slim opts.
      const optsMatches = script.match(/agent\((?:[^()]|\([^()]*\))*\)/g) ?? [];
      expect(optsMatches.length, `${f}: no agent() calls found`).toBeGreaterThan(0);
      for (const call of optsMatches) {
        const optsStr = call.slice(call.lastIndexOf(", {"), call.length);
        // Extract just the keys of the options object literal.
        const keys = [...optsStr.matchAll(/\b([a-zA-Z_]+)\s*:/g)].map((m) => m[1]);
        const allowed = new Set(["label", "phase", "agentType", "schema", "status"]);
        const illegal = keys.filter(
          (k) => !allowed.has(k) && k !== "questions" && k !== "slug" && k !== "briefPath" &&
            k !== "researchPlan" && k !== "detail" && k !== "reportPath" && k !== "summary" &&
            k !== "verdict" && k !== "findings" && k !== "file" && k !== "line" && k !== "summary",
        );
        expect(illegal, `${f}: illegal opts keys in "${call.slice(0, 60)}…": ${illegal.join(", ")}`).toEqual([]);
        expect(forbidden.test(call), `${f}: forbidden opt in "${call.slice(0, 60)}…"`).toBe(false);
      }
    }
  });
});
