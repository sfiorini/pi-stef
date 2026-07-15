import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_FILES = [
  "reviewer.md",
  "explorer.md",
  "auditor.md",
  "planner.md",
  "developer.md",
  "synth.md",
] as const;
const GLOBAL_AGENTS_SUBPATH = [".pi", "agent", "agents"] as const;
const PROJECT_AGENTS_SUBPATH = [".pi", "agents"] as const;
const STALE_PLACEHOLDER = "{{REVIEWER_MODEL}}";

export interface EnsureAgentFilesResult {
  /** Human-readable warnings (e.g. a stale adapter-era project agent file). */
  warnings: string[];
}

/**
 * Ensure the six flow agent definition files exist in the global discovery dir
 * (`~/.pi/agent/agents/`): reviewer, explorer, auditor, planner, developer, synth.
 *
 * WRITE-ONCE: if a file already exists it is left untouched so the user can
 * edit it. No file carries a `model:` frontmatter field — the model is
 * resolved by flow and passed at dispatch time.
 *
 * Also detects a STALE adapter-era project `<cwd>/.pi/agents/reviewer.md`
 * still containing the `{{REVIEWER_MODEL}}` placeholder — such a file would
 * shadow the new global reviewer. It is NOT deleted (user-owned); a warning
 * is returned so the caller can surface it.
 *
 * @param homeDir The user home directory.
 * @param cwd The current working directory (project root). Defaults to process.cwd().
 */
export async function ensureAgentFiles(
  homeDir: string,
  cwd: string = process.cwd(),
): Promise<EnsureAgentFilesResult> {
  const warnings: string[] = [];
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const agentsDir = join(homeDir, ...GLOBAL_AGENTS_SUBPATH);
  await mkdir(agentsDir, { recursive: true });

  for (const file of AGENT_FILES) {
    const target = join(agentsDir, file);
    try {
      await readFile(target, "utf8");
      // Already exists — do not clobber user edits.
      continue;
    } catch (err: unknown) {
      if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        throw err;
      }
    }
    const template = await readFile(join(pkgRoot, "agents", file), "utf8");
    await writeFile(target, template, "utf8");
  }

  // Detect stale adapter-era project reviewer file (project overrides global).
  const projectReviewer = join(cwd, ...PROJECT_AGENTS_SUBPATH, "reviewer.md");
  try {
    const existing = await readFile(projectReviewer, "utf8");
    if (existing.includes(STALE_PLACEHOLDER)) {
      warnings.push(
        `Found a stale adapter-era project agent file at ${projectReviewer} containing "${STALE_PLACEHOLDER}". ` +
          `In pi-subagents, a project agent overrides the global one, so this stale file will shadow the new global reviewer. Remove it (rm ${projectReviewer}) to use the migrated global definition.`,
      );
    }
  } catch (err: unknown) {
    if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
    // No project file — good.
  }

  return { warnings };
}
