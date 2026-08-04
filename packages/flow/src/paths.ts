import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { globalDir, projectDir } from "@pi-stef/paths";

// ESM-safe package root. This file lives at packages/flow/src/paths.ts, so ONE
// ".." reaches packages/flow — matching the existing seed.ts / messages.ts
// `fileURLToPath(import.meta.url)` pattern. Never use __dirname (this package
// is ESM-only).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the installed flow package root (packages/flow). */
export function packageRoot(): string {
  return PKG_ROOT;
}

/** Absolute path to the bundled templates directory (packages/flow/templates). */
export function templatesDir(): string {
  return join(PKG_ROOT, "templates");
}

/** Absolute path to the plan-file skeletons (packages/flow/templates/plan). */
export function planTemplatesDir(): string {
  return join(templatesDir(), "plan");
}

/**
 * Resolve a template reference to an absolute path. `@flow/...` refs resolve
 * against the bundled templates dir; everything else (repo-relative or
 * absolute) is returned as-is so the caller can stat it.
 */
export function resolveTemplate(ref: string): string {
  if (ref.startsWith("@flow/")) return join(templatesDir(), ref.slice("@flow/".length));
  return ref;
}

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
