import { spawnSync } from "node:child_process";

/**
 * Validate that `cwd` is a clean git working tree. Returns when:
 *   - cwd is inside a git repo
 *   - working tree has no untracked, modified, staged, or deleted files
 *     (unless `allowDirty=true`)
 *
 * Throws {@link RepoStateError} on any violation. The error carries the
 * `kind` so callers can format friendly messages.
 */
export type RepoStateViolation = "not-a-git-repo" | "dirty-tree";

/**
 * Thrown by `assertIsGitRepo` when the workflow's cwd is not inside a
 * git work tree. Distinct from RepoStateError so the workflow-entry
 * preflight (which only cares about repo presence, NOT dirty state) can
 * be caught separately from the worktree-creation validator.
 *
 * `cause` distinguishes the surface: `"git-missing"` when the `git` CLI
 * itself is unreachable (ENOENT from spawn), `"not-a-repo"` when git
 * ran but the cwd isn't a work tree (covers bare repos and `.git/`
 * internals — both return "false" from rev-parse).
 */
export type GitRepoMissingCause = "git-missing" | "not-a-repo";

export class GitRepoMissingError extends Error {
  readonly tool: string;
  readonly cwd: string;
  readonly cause: GitRepoMissingCause;
  constructor(tool: string, cwd: string, cause: GitRepoMissingCause = "not-a-repo") {
    const message =
      cause === "git-missing"
        ? `${tool}: \`git\` CLI not found on PATH (cwd: ${cwd}).\n` +
          `This workflow needs git for branch / worktree / commit operations.\n` +
          `Install git (e.g. \`brew install git\` on macOS) and re-try.`
        : `${tool}: not a git repository: ${cwd}\n` +
          `This workflow needs git for branch / worktree / commit operations.\n` +
          `Run \`git init\` in ${cwd} (and optionally make an initial commit), then re-try.`;
    super(message);
    this.name = "GitRepoMissingError";
    this.tool = tool;
    this.cwd = cwd;
    this.cause = cause;
  }
}

/**
 * Lightweight preflight: throw {@link GitRepoMissingError} when `cwd`
 * is not inside a git work tree. Used at the entry of every sf-team
 * workflow that performs git operations (implement, auto, task,
 * followup) so the user gets a fast, friendly error BEFORE any agent
 * is spawned and BEFORE any planner / reviewer tokens are spent.
 *
 * Plan-only workflows (`sf_team_plan`) skip this — they're read-only
 * and don't need a git repo to produce a plan.
 *
 * Does NOT check dirty state. Dirty checks are config-driven and run
 * later inside `validateRepoState` at worktree-creation time.
 *
 * Behavior in edge cases:
 *   - `git` not on PATH       → throws with `cause: "git-missing"` (ENOENT).
 *   - cwd is a bare repo      → throws with `cause: "not-a-repo"` (downstream
 *                                worktree / commit ops all assume a real
 *                                work tree, so a bare repo is rejected).
 *   - cwd inside `.git/` dir  → throws with `cause: "not-a-repo"`.
 *   - cwd is a non-bare repo  → returns silently.
 *
 * `GIT_DIR` and `GIT_WORK_TREE` are explicitly stripped from the child
 * env so a stale shell export can't fool the preflight into reporting
 * a non-repo cwd as a repo.
 */
export function assertIsGitRepo(tool: string, cwd: string): void {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } as NodeJS.ProcessEnv,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new GitRepoMissingError(tool, cwd, "git-missing");
  }
  if (r.status === 0 && (r.stdout ?? "").trim() === "true") return;
  throw new GitRepoMissingError(tool, cwd, "not-a-repo");
}

/**
 * Throws {@link GitRepoMissingError} only when `ctx.gitMode === 'on'` and the
 * cwd is not a git repo. When `gitMode === 'off'`, this is a no-op.
 * Replaces direct `assertIsGitRepo` call sites for gitMode-aware code paths.
 */
export function requireGitOrSkip(
  ctx: { repoRoot: string; gitMode: "on" | "off"; __testGitProbe?: (cwd: string) => boolean },
  toolName: string,
): void {
  if (ctx.gitMode !== "on") return;
  if (ctx.__testGitProbe) {
    if (!ctx.__testGitProbe(ctx.repoRoot)) {
      throw new GitRepoMissingError(toolName, ctx.repoRoot, "not-a-repo");
    }
    return;
  }
  assertIsGitRepo(toolName, ctx.repoRoot);
}

export interface RepoStateError extends Error {
  kind: RepoStateViolation;
  details?: string;
}

export function validateRepoState(cwd: string, opts: { allowDirty?: boolean } = {}): void {
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw makeError("not-a-git-repo", `not a git repository: ${cwd}`, inside.stderr);
  }
  if (opts.allowDirty) return;
  const status = runGit(["status", "--porcelain=1", "--untracked-files=normal"], cwd);
  if (status.status !== 0) {
    throw makeError("dirty-tree", `git status failed in ${cwd}`, status.stderr);
  }
  const dirtyLines = status.stdout
    .split("\n")
    .map((s) => s.replace(/[\r\n]+$/, ""))
    .filter((s) => s.length > 0);
  if (dirtyLines.length > 0) {
    throw makeError(
      "dirty-tree",
      `working tree dirty (${dirtyLines.length} file(s)); pass --allow-dirty to override`,
      dirtyLines.join("\n"),
    );
  }
}

function runGit(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeError(kind: RepoStateViolation, message: string, details?: string): RepoStateError {
  const err = new Error(message) as RepoStateError;
  err.kind = kind;
  if (details) err.details = details;
  return err;
}
