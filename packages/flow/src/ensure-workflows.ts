import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_WORKFLOWS = [
  "code-review.yaml",
  "ship-feature.yaml",
  "auth-audit.yaml",
  "research-report.yaml",
] as const;
const PROJECT_WORKFLOWS_SUBPATH = [".pi", "workflows"] as const;

export interface EnsureExampleWorkflowsResult {
  /** Basenames of workflows newly written this call (already-present files are skipped). */
  seeded: string[];
}

/**
 * Ensure the bundled example workflows exist in the project's
 * `<repoRoot>/.pi/workflows/` directory: `code-review`, `ship-feature`,
 * `auth-audit`, `research-report`.
 *
 * WRITE-ONCE: if a file already exists it is left untouched so the user can
 * edit or delete examples freely. Mirrors `ensureAgentFiles`, but targets the
 * project (workflows are project-scoped, read by `sf_flow_auto`) rather than
 * the global agent discovery dir.
 *
 * Called from the `sf_flow_plan` / `sf_flow_implement` / `sf_flow_auto` tool
 * handlers so the examples appear on first use — no manual copy from GitHub.
 *
 * @param repoRoot The project root (where `.pi/workflows/` lives).
 */
export async function ensureExampleWorkflows(
  repoRoot: string,
): Promise<EnsureExampleWorkflowsResult> {
  const seeded: string[] = [];
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const destDir = join(repoRoot, ...PROJECT_WORKFLOWS_SUBPATH);
  await mkdir(destDir, { recursive: true });

  for (const file of EXAMPLE_WORKFLOWS) {
    const target = join(destDir, file);
    try {
      await readFile(target, "utf8");
      // Already exists — do not clobber user edits.
      continue;
    } catch (err: unknown) {
      if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        throw err;
      }
    }
    const template = await readFile(join(pkgRoot, "workflows", file), "utf8");
    await writeFile(target, template, "utf8");
    seeded.push(file);
  }

  return { seeded };
}
