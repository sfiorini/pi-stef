import { writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump } from "js-yaml";
import type { FlowYaml } from "./schema.js";

/**
 * Serialize a FlowYaml to `<workflowsDir>/<name>.yaml` SYNCHRONOUSLY and return
 * the absolute path. Used by the create-workflow wizard / tests.
 */
export function writeFlowYaml(workflowsDir: string, flow: FlowYaml): string {
  mkdirSync(workflowsDir, { recursive: true });
  const path = join(workflowsDir, `${flow.name}.yaml`);
  writeFileSync(path, dump(flow, { lineWidth: 100 }), "utf8");
  return path;
}

/**
 * Async variant for tool execute paths. Serializes and writes the FlowYaml to
 * `<workflowsDir>/<name>.yaml`; returns the path. Does NOT validate — callers
 * must run `validateFlowYaml` themselves (the wizard does this in Phase 3).
 */
export async function writeFlowYamlAsync(workflowsDir: string, flow: FlowYaml): Promise<string> {
  await mkdir(workflowsDir, { recursive: true });
  const path = join(workflowsDir, `${flow.name}.yaml`);
  await writeFile(path, dump(flow, { lineWidth: 100 }), "utf8");
  return path;
}
