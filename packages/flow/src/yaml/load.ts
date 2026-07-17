import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { Value } from "@sinclair/typebox/value";
import { FlowYamlSchema, type FlowYaml } from "./schema.js";
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
 * Two phases: `Value.Cast` normalizes the parsed object (strips extras, coerces
 * scalar kinds) without throwing; `validateFlowYaml` then runs the strict
 * TypeBox `Value.Errors` pass plus the cross-field rules, so no invalid flow is
 * returned. YAML parse errors and validation failures both raise
 * `FlowYamlLoadError` (carrying the file path); a missing file propagates the
 * underlying `ENOENT`.
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
  const flow = Value.Cast(FlowYamlSchema, parsed);
  const result = validateFlowYaml(flow);
  if (!result.ok) {
    throw new FlowYamlLoadError(file, `invalid flow: ${result.errors.join("; ")}`);
  }
  return flow;
}
