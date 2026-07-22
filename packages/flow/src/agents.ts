import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { seedAgents } from "./seed.js";

const GLOBAL_AGENTS_SUBPATH = [".pi", "agent", "agents"] as const;
const PROJECT_AGENTS_SUBPATH = [".pi", "agents"] as const;
const STALE_PLACEHOLDER = "{{REVIEWER_MODEL}}";

export interface EnsureAgentFilesResult {
  /** Human-readable warnings (e.g. a stale adapter-era project agent file). */
  warnings: string[];
}

/**
 * Ensure the eight flow agent definition files exist in the global discovery dir
 * (`~/.pi/agent/agents/`): reviewer, explorer, auditor, planner, developer, synth, scanner, researcher.
 *
 * WRITE-ONCE: if a file already exists it is left untouched so the user can
 * edit it. Uses an exclusive (`wx`) create so a concurrent writer can't be
 * silently clobbered. No file carries a `model:` frontmatter field — the model
 * is resolved by flow and passed at dispatch time.
 *
 * Also detects a STALE adapter-era project `<cwd>/.pi/agents/reviewer.md` still
 * containing the `{{REVIEWER_MODEL}}` placeholder — such a file would shadow the
 * new global reviewer. It is NOT deleted (user-owned); a warning is returned so
 * the caller can surface it.
 *
 * @param homeDir The user home directory.
 * @param cwd The current working directory (project root). Defaults to process.cwd().
 */
export async function ensureAgentFiles(
  homeDir: string,
  cwd: string = process.cwd(),
): Promise<EnsureAgentFilesResult> {
  const warnings: string[] = [];
  const agentsDir = join(homeDir, ...GLOBAL_AGENTS_SUBPATH);
  await seedAgents(agentsDir, "write-once");

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

/**
 * Resolve the pi-subagents agent TYPE for a named flow role, given the set of
 * agent definition files (basenames) that actually exist. This is the single
 * source of truth for the resolution rule — mirrored verbatim in every tier-1
 * skill's "Agent resolution" section:
 *
 * 1. If a `<name>.md` definition exists → spawn that named agent (`name`).
 * 2. Else if `name === "planner"` → fall back to the built-in `Plan` agent.
 * 3. Else if `name === "reviewer"` → fall back to the built-in `Reviewer` agent.
 * 4. Else → `general-purpose`.
 *
 * Matching is case-insensitive (a lowercase `.md` name wins regardless of the
 * casing used to reference it). Critically, a missing `explorer.md` does NOT
 * fall back to the built-in `Explore` agent (which forces Haiku) — it yields
 * `general-purpose` instead, so the orchestrator model is inherited.
 *
 * @param name The role name referenced by a phase/skill (e.g. "reviewer").
 * @param agentFiles The available agent identifiers — either basenames
 *   (`["reviewer.md", "explorer.md"]`, as used at runtime) OR bare keys
 *   (`["reviewer", "explorer"]`, as declared in a workflow YAML). A trailing
 *   `.md` is stripped before comparing, so both forms work.
 */
export function resolveAgentType(name: string, agentFiles: string[]): string {
  const lower = name.toLowerCase();
  const exists = agentFiles.some((f) => f.toLowerCase().replace(/\.md$/, "") === lower);
  if (exists) return lower;
  if (lower === "planner") return "Plan";
  if (lower === "reviewer") return "Reviewer";
  return "general-purpose";
}
