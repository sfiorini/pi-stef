import { spawnSync } from "node:child_process";

export interface ExistingWorktree {
  path: string;
  branch: string;
  head: string;
}

export function listExistingWorktrees(repoRoot: string): ExistingWorktree[] {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) return [];
  const lines = r.stdout.split("\n");
  let current: Partial<ExistingWorktree> = {};
  const all: ExistingWorktree[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/[\r\n]+$/, "");
    if (trimmed.length === 0) {
      if (current.path && current.branch && current.head) all.push(current as ExistingWorktree);
      current = {};
      continue;
    }
    const [key, ...rest] = trimmed.split(" ");
    const value = rest.join(" ");
    switch (key) {
      case "worktree":
        current.path = value;
        break;
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
    }
  }
  if (current.path && current.branch && current.head) all.push(current as ExistingWorktree);
  return all;
}

/**
 * Find an existing git worktree whose branch matches `branch`. Used by
 * sf_team_followup to reuse the parent's worktree when still alive.
 */
export function findExistingWorktree(repoRoot: string, branch: string): ExistingWorktree | undefined {
  return listExistingWorktrees(repoRoot).find((w) => w.branch === branch);
}
