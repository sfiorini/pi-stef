import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import type { FlowYaml } from "./schema.js";
import { validateFlowYaml } from "./validate.js";

export class FlowYamlLoadError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(message);
    this.name = "FlowYamlLoadError";
  }
}

/**
 * Parse and validate a workflow YAML file into a `FlowYaml`.
 *
 * `validateFlowYaml` runs the strict TypeBox `Value.Errors` pass plus the
 * cross-field rules, so no invalid flow is returned. We intentionally do NOT
 * use `Value.Cast` here: it is unreliable under pi's extension loader at
 * runtime (it throws "Value.Cast is not a function"), whereas `Value.Errors`
 * / `Value.Check` work fine (used across pair/team/flow). Strict validation is
 * also preferable to silent coercion for workflow files.
 *
 * YAML parse errors and validation failures both raise `FlowYamlLoadError`
 * (carrying the file path); a missing file propagates the underlying `ENOENT`.
 */
export async function loadFlowYaml(file: string): Promise<FlowYaml> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (err) {
    throw new FlowYamlLoadError(
      file,
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = validateFlowYaml(parsed);
  if (!result.ok) {
    throw new FlowYamlLoadError(file, `invalid flow: ${result.errors.join("; ")}`);
  }
  return parsed as FlowYaml;
}
