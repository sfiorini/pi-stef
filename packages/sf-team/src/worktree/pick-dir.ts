import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Pick a directory for the worktree. Default placement keeps worktrees
 * OUTSIDE the parent repo so the parent's working tree never reports them
 * as untracked. Priority:
 *   1. <repoRoot>/../<repoBaseName>-worktrees/<slug>   ← sibling, default
 *   2. <repoRoot>/.worktrees/<slug>                     ← only if it already exists
 *   3. <repoRoot>/worktrees/<slug>                      ← only if it already exists
 * Inside-repo bases are honored only when the caller has already adopted them
 * (and presumably gitignored them). On collision, appends -2 / -3 / … to the
 * slug until a free path is found.
 *
 * Honors a repo-local override via `git config sf-team.worktreeRoot <abs-path>`,
 * which jumps to the front of the priority list when set.
 */
export function pickWorktreeDir(repoRoot: string, slug: string): string {
  const repoBase = path.basename(repoRoot);
  const candidates: string[] = [];
  const override = readGitConfigValue(repoRoot, "sf-team.worktreeRoot");
  if (override) candidates.push(override);
  // Default = sibling. Worktrees live OUTSIDE repoRoot so they can't dirty
  // the parent.
  candidates.push(path.join(path.dirname(repoRoot), `${repoBase}-worktrees`));
  // Honor inside-repo bases only when the user has already created them
  // (signal of opt-in: presumably with .gitignore lines for them).
  const insideHidden = path.join(repoRoot, ".worktrees");
  if (existsSync(insideHidden)) candidates.unshift(insideHidden);
  const insideVisible = path.join(repoRoot, "worktrees");
  if (existsSync(insideVisible)) candidates.unshift(insideVisible);
  const baseDir = candidates[0];
  let candidate = path.join(baseDir, slug);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = path.join(baseDir, `${slug}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function readGitConfigValue(cwd: string, key: string): string | undefined {
  const r = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const v = r.stdout.trim();
  return v.length > 0 ? v : undefined;
}
