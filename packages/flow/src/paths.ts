import { join } from "node:path";
import { access } from "node:fs/promises";
import { globalDir, projectDir } from "@pi-stef/paths";

/** `~/.pi/sf/flow/workflows/` — global default workflows, available in every project. */
export function globalWorkflowsDir(home: string): string {
  return join(globalDir("flow", home), "workflows");
}

/** `<repoRoot>/.pi/sf/flow/workflows/` — project-scoped workflows that override globals. */
export function projectWorkflowsDir(repoRoot: string): string {
  return join(projectDir("flow", repoRoot), "workflows");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (err) {
    // Only "not found" means absent; propagate permission/other errors so a
    // broken-permission project file doesn't silently invert precedence.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Resolve a workflow name to its YAML path: a project override wins, else the
 * global default, else null. Mirrors pi's agent + config precedence (project
 * overrides global). Returns the absolute path or null when no such workflow
 * exists in either location.
 */
export async function resolveWorkflowPath(
  name: string,
  repoRoot: string,
  home: string,
): Promise<string | null> {
  const projectFile = join(projectWorkflowsDir(repoRoot), `${name}.yaml`);
  if (await exists(projectFile)) return projectFile;
  const globalFile = join(globalWorkflowsDir(home), `${name}.yaml`);
  if (await exists(globalFile)) return globalFile;
  return null;
}
