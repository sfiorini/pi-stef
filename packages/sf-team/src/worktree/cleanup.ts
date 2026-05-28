import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";

import { releaseLock } from "../plan/lock";
import { validateWorktreeBranchName } from "./create";

/**
 * Remove a worktree if it has neither uncommitted changes (porcelain status
 * empty) NOR commits ahead of its base branch. Used as a safe rollback after
 * a failed createWorktree. If either check fails, returns `false` and leaves
 * the worktree in place — the user decides whether to discard manually.
 *
 * Pass the actual `baseRef` returned by createWorktree so the commits-ahead
 * check is correct even when the parent branch is not main/master. When
 * `baseRef` is omitted, falls back to (in order) `main`, `master`, the
 * current default-branch from `git symbolic-ref refs/remotes/origin/HEAD`.
 */
export async function removeWorktreeIfEmpty(
  repoRoot: string,
  worktreePath: string,
  opts: { baseRef?: string } = {},
): Promise<boolean> {
  const exists = await stat(worktreePath).catch(() => undefined);
  if (!exists || !exists.isDirectory()) return true;

  // 1) porcelain check — uncommitted changes block removal.
  const status = spawnSync("git", ["status", "--porcelain=1"], { cwd: worktreePath, encoding: "utf8" });
  if (status.status === 0 && status.stdout.trim().length > 0) {
    return false;
  }

  // 2) commits-ahead check vs the actual baseRef the worktree was created from.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
  if (head.status === 0) {
    const headSha = head.stdout.trim();
    const baseRefs = opts.baseRef
      ? [opts.baseRef]
      : ["main", "master", "HEAD@{upstream}"];
    for (const ref of baseRefs) {
      const base = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: worktreePath, encoding: "utf8" });
      if (base.status !== 0) continue;
      const baseSha = base.stdout.trim();
      if (baseSha === headSha) return safeForceRemove(repoRoot, worktreePath);
      const ahead = spawnSync("git", ["rev-list", "--count", `${baseSha}..${headSha}`], { cwd: worktreePath, encoding: "utf8" });
      if (ahead.status === 0 && Number(ahead.stdout.trim()) > 0) return false;
      return safeForceRemove(repoRoot, worktreePath);
    }
    // No comparable base ref found; skip the ahead check rather than silently
    // approving a removal that might destroy committed work.
    return false;
  }
  return safeForceRemove(repoRoot, worktreePath);
}

/**
 * Remove a lane worktree after its HEAD has been merged into a parent
 * worktree. Unlike removeWorktreeIfEmpty, this intentionally allows committed
 * lane work because the ancestor check proves the commit is already rolled up.
 */
export async function removeRolledUpWorktree(opts: {
  repoRoot: string;
  worktreePath: string;
  targetCwd: string;
  expectedHead?: string;
}): Promise<boolean> {
  const exists = await stat(opts.worktreePath).catch(() => undefined);
  if (!exists || !exists.isDirectory()) return true;

  const status = spawnSync("git", ["status", "--porcelain=1"], { cwd: opts.worktreePath, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim().length > 0) return false;

  const sourceHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: opts.worktreePath, encoding: "utf8" });
  if (sourceHead.status !== 0) return false;
  const sourceSha = sourceHead.stdout.trim();
  if (opts.expectedHead && sourceSha !== opts.expectedHead) return false;

  const targetHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: opts.targetCwd, encoding: "utf8" });
  if (targetHead.status !== 0) return false;
  const targetSha = targetHead.stdout.trim();

  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, targetSha], {
    cwd: opts.targetCwd,
    encoding: "utf8",
  });
  if (ancestor.status !== 0) return false;

  return safeForceRemove(opts.repoRoot, opts.worktreePath);
}

function safeForceRemove(repoRoot: string, worktreePath: string): boolean {
  const r = spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0;
}

/**
 * Discriminated union of outcomes from `tryDeleteBranch` that did NOT
 * actually delete the branch. The struct shape is consumed by
 * `SfTeamImplementResult.warnings` so tool callers can see exactly why
 * cleanup chose to leave a branch in place.
 *
 * `lane_branch_already_deleted` is distinct from `lane_branch_kept`
 * (R3 P3): "we left it behind" vs. "it was already gone before we
 * started", so warnings consumers can distinguish the two failure
 * modes.
 */
export type BranchCleanupWarning =
  | { kind: "lane_branch_kept"; lane: string; reason: string }
  | { kind: "lane_branch_already_deleted"; lane: string; reason: string }
  | { kind: "lane_branch_invalid_name"; lane: string; reason: string }
  | { kind: "lane_branch_ref_moved"; lane: string; reason: string }
  | { kind: "lane_branch_not_ancestor"; lane: string; reason: string };

export type TryDeleteBranchResult = { deleted: true } | BranchCleanupWarning;

export interface TryDeleteBranchOptions {
  branchName: string;
  repoRoot: string;
  /**
   * Commit sha that the lane was at when its merge was finalized. Cleanup
   * refuses to delete unless `git show-ref --hash --verify refs/heads/<branch>`
   * still matches this exact sha — protects against another worktree
   * pushing new commits onto the lane between rollup and teardown.
   */
  expectedSha: string;
  /**
   * Branch (or commit) the lane should already be merged into. Cleanup
   * runs `git merge-base --is-ancestor <expectedSha> <mergeTarget>` to
   * confirm the merge actually landed before deleting. **Must be the
   * direct parent target:** `aggregateBranch` for milestone lanes, the
   * milestone branch for story lanes (R4 P2 — story lanes merge into the
   * milestone first, then later into the aggregate).
   */
  mergeTarget: string;
}

/**
 * Best-effort lane-branch deletion after a successful merge + worktree
 * removal. NEVER throws — every failure mode (missing branch, ref-moved,
 * not-ancestor, git-error) returns a `BranchCleanupWarning` describing
 * what happened. Callers append the warning to
 * `SfTeamImplementResult.warnings` and continue.
 *
 * Four guards before any destructive `git branch -d/-D`:
 *   1. `validateWorktreeBranchName` — same validator used at lane
 *      creation, rejects shell-meta, dot-segments, leading/trailing
 *      slash, empty parts.
 *   2. `git show-ref --verify --quiet refs/heads/<branch>` — branch
 *      exists.
 *   3. `git show-ref --hash --verify refs/heads/<branch>` matches
 *      `expectedSha` — no concurrent worktree advanced the tip. (R3 P2
 *      verified: `git rev-parse --verify -- refs/heads/<branch>` fails
 *      with "Needed a single revision"; the `show-ref --hash --verify`
 *      form is the correct one.)
 *   4. `git merge-base --is-ancestor <expectedSha> <mergeTarget>` — the
 *      lane's commit was already merged into the parent target. R4 P2
 *      regression: pass the right `mergeTarget` (`aggregateBranch` for
 *      milestone lanes, milestone branch for story lanes).
 *
 * Then `git branch -d -- <branchName>`. On exit 0 → `{ deleted: true }`.
 * On stderr containing `not fully merged` AND with all four guards
 * passed, retry with `git branch -D -- <branchName>` (safe: we proved
 * we did the merge). Any other failure → `lane_branch_kept` with the
 * stderr first line as `reason`.
 */
export function tryDeleteBranch(opts: TryDeleteBranchOptions): TryDeleteBranchResult {
  const { branchName, repoRoot, expectedSha, mergeTarget } = opts;

  // Guard 1: name validation (reuses the worktree creator's validator).
  try {
    validateWorktreeBranchName(branchName);
  } catch (err) {
    return {
      kind: "lane_branch_invalid_name",
      lane: branchName,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Guard 2: branch exists.
  const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (exists.status !== 0) {
    return {
      kind: "lane_branch_already_deleted",
      lane: branchName,
      reason: `no refs/heads/${branchName} at cleanup time`,
    };
  }

  // Guard 3: ref tip matches expectedSha. R3 P2 — use the
  // `show-ref --hash --verify` form; `rev-parse --verify -- <ref>` fails
  // with "Needed a single revision" when invoked with the `--` separator.
  const tip = spawnSync("git", ["show-ref", "--hash", "--verify", `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (tip.status !== 0) {
    return {
      kind: "lane_branch_kept",
      lane: branchName,
      reason: firstLine(tip.stderr) || "show-ref --hash --verify failed",
    };
  }
  const actualSha = tip.stdout.trim();
  if (actualSha !== expectedSha) {
    return {
      kind: "lane_branch_ref_moved",
      lane: branchName,
      reason: `expected ${expectedSha}, got ${actualSha}`,
    };
  }

  // Guard 4: ancestor check. The lane commit must already be merged into
  // the parent target.
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", expectedSha, mergeTarget], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (ancestor.status !== 0) {
    return {
      kind: "lane_branch_not_ancestor",
      lane: branchName,
      reason: `${expectedSha} is not ancestor of ${mergeTarget}`,
    };
  }

  // Destructive step: try the safe `-d` first; fall back to `-D` only on
  // a "not fully merged" message AND when all guards passed (so we know
  // the merge actually happened).
  const safeDelete = spawnSync("git", ["branch", "-d", "--", branchName], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (safeDelete.status === 0) {
    return { deleted: true };
  }
  const safeStderr = safeDelete.stderr ?? "";
  if (/not fully merged/i.test(safeStderr)) {
    const force = spawnSync("git", ["branch", "-D", "--", branchName], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (force.status === 0) {
      return { deleted: true };
    }
    return {
      kind: "lane_branch_kept",
      lane: branchName,
      reason: firstLine(force.stderr) || `git branch -D -- ${branchName} failed`,
    };
  }
  return {
    kind: "lane_branch_kept",
    lane: branchName,
    reason: firstLine(safeStderr) || `git branch -d -- ${branchName} failed`,
  };
}

function firstLine(text: string | undefined): string {
  if (!text) return "";
  const i = text.indexOf("\n");
  return (i === -1 ? text : text.slice(0, i)).trim();
}

/**
 * Convenience for tool finally-blocks: best-effort lock release + worktree
 * removal in a single call. Safe to invoke when neither resource exists.
 */
export async function cleanupWorktreeAndLock(opts: {
  repoRoot: string;
  worktreePath?: string;
  baseRef?: string;
  slug?: string;
}): Promise<void> {
  if (opts.worktreePath) {
    await removeWorktreeIfEmpty(opts.repoRoot, opts.worktreePath, { baseRef: opts.baseRef }).catch(() => undefined);
  }
  if (opts.slug) {
    await releaseLock(opts.repoRoot, opts.slug).catch(() => undefined);
  }
}
