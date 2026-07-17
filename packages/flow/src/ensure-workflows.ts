import { seedWorkflows } from "./seed.js";
import { globalWorkflowsDir } from "./paths.js";

export interface EnsureExampleWorkflowsResult {
  /** Basenames of workflows newly written this call (already-present files are skipped). */
  seeded: string[];
}

/**
 * Ensure the bundled example workflows exist in the GLOBAL workflows dir
 * (`~/.pi/sf/flow/workflows/`) so they are available in every project.
 * Write-once: existing files are left untouched so the user can edit or delete
 * examples freely. Mirrors `ensureAgentFiles`, but targets the global workflows
 * dir (workflows are resolved project→global by `resolveWorkflowPath`).
 *
 * Called from the `sf_flow_plan` / `sf_flow_implement` / `sf_flow_auto` handlers
 * so the examples appear on first use. For explicit (re-)seeding with `.new`
 * diffing of changed files, use `/sf-flow-seed`.
 *
 * @param home The user home directory (the global workflows dir lives under it).
 */
export async function ensureExampleWorkflows(home: string): Promise<EnsureExampleWorkflowsResult> {
  const results = await seedWorkflows(globalWorkflowsDir(home), "write-once");
  return { seeded: results.filter((r) => r.status === "written").map((r) => r.file) };
}
