import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { DEFAULT_CONFIG, type ResolvedDefaults } from "../config/schema";
import type { AgentRole, TeamMember } from "../runtime/types";

/**
 * Leaf helpers shared by `sf_team_task` and `sf_team_followup`. Both tools
 * run the same git/diff/commit lifecycle on top of `runOrchestrator`; they
 * just differ in how they compose the planner brief and what slug shape
 * they pick. Keeping these helpers in one file removes the ~50 lines of
 * duplicated implementation between `task.ts` and `followup.ts`.
 *
 * Error messages embed the caller's tool name so a failure surfaces as
 * `sf_team_task: ...` or `sf_team_followup: ...` rather than a generic
 * helper string.
 */

/** Resolve a default `TeamMember` for the given role from the agents config. */
export function defaultMember(
  role: AgentRole,
  skills: string[],
  agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents,
): TeamMember {
  const d = agents[role];
  return { role, model: d.model, thinking: d.thinking, heartbeatMs: d.heartbeatMs, skills };
}

/**
 * Refuse to enter the workflow when the working tree has untracked or
 * unstaged changes; the caller's `allowDirty` knob should bypass this.
 */
export function assertCleanWorktree(toolName: string, cwd: string): void {
  const r = spawnSync("git", ["status", "--porcelain=1"], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${toolName}: git status failed in ${cwd} — is this a git repo?`);
  }
  if (r.stdout.trim().length > 0) {
    throw new Error(
      `${toolName}: working tree is dirty; pass allowDirty=true to override or commit/stash first`,
    );
  }
}

/** Read the current staged diff (`git diff --cached`). Returns "" on failure. */
export function readStagedDiff(cwd: string): string {
  const r = spawnSync("git", ["diff", "--cached"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

/** Read the staged diff stat (`git diff --cached --stat`). Returns "" on failure. */
export function readStagedDiffStat(cwd: string): string {
  const r = spawnSync("git", ["diff", "--cached", "--stat"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

/**
 * Commit the staged diff with `message`. Returns the commit SHA, or
 * `undefined` when there were no staged changes AND the most recent HEAD
 * commit's subject does not match — i.e. nothing to do and no idempotent
 * match. Throws (with the tool-name prefix) when git itself fails.
 */
export function commitStaged(toolName: string, cwd: string, message: string): string | undefined {
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd, encoding: "utf8" });
  if (staged.status === 0) return headCommitWithSubject(cwd, message);
  if (staged.status !== 1) {
    throw new Error(`${toolName}: git diff --cached failed: ${formatGitFailure(staged)}`);
  }
  const r = spawnSync("git", ["commit", "-q", "-m", message], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${toolName}: git commit failed: ${formatGitFailure(r)}`);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return head.stdout.trim() || undefined;
}

/**
 * If HEAD's commit subject matches `message`, return its SHA. Used by
 * `commitStaged` so a resumed run that already committed the developer's
 * staged diff (and thus has nothing left staged) can still report a
 * commit SHA instead of "no commit".
 */
export function headCommitWithSubject(cwd: string, message: string): string | undefined {
  const r = spawnSync("git", ["log", "-1", "--format=%H%x00%s"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const [hash, subject] = r.stdout.split("\0");
  return subject?.trim() === message ? hash?.trim() || undefined : undefined;
}

/** Render the most useful information out of a SpawnSyncReturns failure. */
export function formatGitFailure(result: SpawnSyncReturns<string>): string {
  const detail = (result.stderr || result.stdout || "").trim();
  if (detail) return detail;
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  return `exit status ${result.status ?? "unknown"}`;
}
