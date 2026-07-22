import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The eight flow agent definitions (shipped under `<pkg>/agents/`). */
export const AGENT_FILES = [
  "reviewer.md",
  "explorer.md",
  "auditor.md",
  "planner.md",
  "developer.md",
  "synth.md",
  "scanner.md",
  "researcher.md",
] as const;

/** The four bundled example workflows (shipped under `<pkg>/workflows/`). */
export const WORKFLOW_FILES = [
  "code-review.yaml",
  "ship-feature.yaml",
  "auth-audit.yaml",
  "research-report.yaml",
] as const;

export type SeedMode = "write-once" | "with-new";
export type SeedStatus = "written" | "skipped" | "up-to-date" | "saved-as-new";

export interface SeedResult {
  /** Basename of the target file (e.g. `reviewer.md`). */
  file: string;
  status: SeedStatus;
  /** Absolute path of the `<name>.new` file, set only for `saved-as-new`. */
  newPath?: string;
}

function isCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isCode(err, "ENOENT")) return undefined;
    throw err;
  }
}

/**
 * Seed a single file.
 *
 * - **`write-once`** (lazy seeding on first flow-tool use): write the template
 *   only if the target is absent; if it exists, leave it untouched. The create
 *   uses `flag: "wx"` so a concurrent writer can't be silently clobbered
 *   (TOCTOU-safe).
 * - **`with-new`** (explicit `/sf-flow-seed`): missing → write; byte-identical
 *   → up-to-date; differs → write the template to `<name>.new` so the user can
 *   diff/merge without ever losing their edits.
 *
 * Non-ENOENT read errors (e.g. EISDIR) propagate — they signal a real problem,
 * not an absent file.
 */
export async function seedFile(
  target: string,
  template: string,
  mode: SeedMode,
): Promise<SeedResult> {
  const file = basename(target);
  const existing = await readOrUndefined(target);

  if (mode === "write-once") {
    if (existing !== undefined) return { file, status: "skipped" };
    try {
      await writeFile(target, template, { encoding: "utf8", flag: "wx" });
      return { file, status: "written" };
    } catch (err) {
      // Raced between our read and write — another writer created it. Treat as
      // already-present rather than clobbering.
      if (isCode(err, "EEXIST")) return { file, status: "skipped" };
      throw err;
    }
  }

  // with-new
  if (existing === undefined) {
    try {
      await writeFile(target, template, { encoding: "utf8", flag: "wx" });
      return { file, status: "written" };
    } catch (err) {
      // Raced: another writer created the file between our read and write.
      // Re-read and classify against the template so the report stays accurate.
      if (isCode(err, "EEXIST")) {
        const raced = await readOrUndefined(target);
        if (raced === template) return { file, status: "up-to-date" };
        const newPath = `${target}.new`;
        await writeFile(newPath, template, "utf8");
        return { file, status: "saved-as-new", newPath };
      }
      throw err;
    }
  }
  if (existing === template) return { file, status: "up-to-date" };
  const newPath = `${target}.new`;
  // Plain write: `.new` always reflects the latest bundled template (overwrites
  // a stale `.new` from a previous release).
  await writeFile(newPath, template, "utf8");
  return { file, status: "saved-as-new", newPath };
}

async function seedAll(
  destDir: string,
  templateSubdir: string,
  files: readonly string[],
  mode: SeedMode,
): Promise<SeedResult[]> {
  await mkdir(destDir, { recursive: true });
  const results: SeedResult[] = [];
  for (const f of files) {
    const template = await readFile(join(pkgRoot, templateSubdir, f), "utf8");
    results.push(await seedFile(join(destDir, f), template, mode));
  }
  return results;
}

/** Seed the eight agents into a directory (the global discovery dir). */
export function seedAgents(agentsDir: string, mode: SeedMode): Promise<SeedResult[]> {
  return seedAll(agentsDir, "agents", AGENT_FILES, mode);
}

/** Seed the four example workflows into a workflows directory. */
export function seedWorkflows(workflowsDir: string, mode: SeedMode): Promise<SeedResult[]> {
  return seedAll(workflowsDir, "workflows", WORKFLOW_FILES, mode);
}

export interface SeedReport {
  agents: SeedResult[];
  workflows: SeedResult[];
}

/** Human-readable summary of a seed run (for the `/sf-flow-seed` tool output). */
export function renderSeedReport(report: SeedReport): string {
  const all = [...report.agents, ...report.workflows];
  const counts: Record<SeedStatus, number> = {
    written: 0,
    skipped: 0,
    "up-to-date": 0,
    "saved-as-new": 0,
  };
  const newPaths: string[] = [];
  for (const r of all) {
    counts[r.status]++;
    if (r.newPath) newPaths.push(r.newPath);
  }
  const lines = [
    `Seeded flow defaults:`,
    `- written: ${counts.written}`,
    `- up-to-date: ${counts["up-to-date"]}`,
    `- saved-as-new: ${counts["saved-as-new"]} (your existing files were left untouched)`,
  ];
  if (newPaths.length) {
    lines.push(``, `New default versions saved beside your files for review:`);
    for (const p of newPaths) lines.push(`- ${p}`);
  }
  return lines.join("\n");
}
