import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WorkflowReporter } from "@pi-stef/agent-workflows";

import { WorktreeCreationError } from "./errors";
import { findExistingWorktree } from "./find";
import { installDependenciesIfMissing } from "./install-deps";
import { pickWorktreeDir } from "./pick-dir";
import { validateRepoState } from "./validate";

export { WorktreeCreationError } from "./errors";

export interface CreateWorktreeOptions {
  repoRoot: string;
  slug: string;
  branchPrefix: string;
  /** Base ref to create the new branch from. Defaults to current HEAD. */
  baseRef?: string;
  /** Pass through to validateRepoState. Defaults false. */
  allowDirty?: boolean;
  /** Override directory picker (test injection). */
  pickDir?: (repoRoot: string, slug: string) => string;
  /** Explicit branch for a parallel milestone/story lane. Defaults to `${branchPrefix}${slug}`. */
  branchName?: string;
  /** Optional workflow reporter for routine dependency-install status. */
  reporter?: WorkflowReporter;
}

export interface CreatedWorktree {
  worktreePath: string;
  branch: string;
  baseRef: string;
  reused?: boolean;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
  // 1) Repo must exist and (unless allowDirty) be clean.
  try {
    validateRepoState(opts.repoRoot, { allowDirty: opts.allowDirty });
  } catch (err) {
    throw new WorktreeCreationError("validate", (err as Error).message);
  }

  // 2) Branch name = `<branchPrefix><slug>` unless a lane passes an explicit
  // branch. Reject collision so the legacy path never reuses an existing branch.
  const branch = opts.branchName ?? `${opts.branchPrefix}${opts.slug}`;
  validateWorktreeBranchName(branch);
  if (branchExists(opts.repoRoot, branch)) {
    throw new WorktreeCreationError(
      "branch-collision",
      `branch '${branch}' already exists; choose a different slug or delete it first`,
    );
  }

  // 3) Pick a worktree directory; pick-dir handles sibling collisions.
  const picker = opts.pickDir ?? pickWorktreeDir;
  const worktreePath = picker(opts.repoRoot, opts.slug);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  // 4) Resolve baseRef. Default = HEAD of the parent at THIS moment, captured
  // as a concrete SHA so subsequent rev-parse calls inside the child worktree
  // (e.g. removeWorktreeIfEmpty's ahead check) compare against the same
  // commit, not the child's current HEAD.
  const requested = opts.baseRef ?? "HEAD";
  const resolved = runGit(["rev-parse", "--verify", "--quiet", `${requested}^{commit}`], opts.repoRoot);
  if (resolved.status !== 0) {
    throw new WorktreeCreationError(
      "git-worktree-add",
      `cannot resolve base ref '${requested}' in ${opts.repoRoot}`,
    );
  }
  const baseRef = resolved.stdout.trim();

  // 5) git worktree add -b <branch> <path> <baseSha>
  const r = runGit(["worktree", "add", "-b", branch, worktreePath, baseRef], opts.repoRoot);
  if (r.status !== 0) {
    throw new WorktreeCreationError(
      "git-worktree-add",
      `git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }

  // 6) Install dependencies in the fresh worktree if applicable.
  // git worktree add does NOT copy untracked files, so node_modules is empty
  // even when the source had a populated install. Without this step, downstream
  // verification gates would hit `<binary>: command not found` on first script run.
  installForWorktree(worktreePath, opts.reporter);

  return { worktreePath, branch, baseRef };
}

export interface EnsureLaneWorktreeOptions {
  repoRoot: string;
  slug: string;
  branchName: string;
  baseRef?: string;
  allowDirty?: boolean;
  /** When resuming, reuse the attached lane even if it contains interrupted edits. */
  allowDirtyAttached?: boolean;
  pickDir?: (repoRoot: string, slug: string) => string;
  reporter?: WorkflowReporter;
}

export async function ensureLaneWorktree(opts: EnsureLaneWorktreeOptions): Promise<CreatedWorktree> {
  try {
    validateRepoState(opts.repoRoot, { allowDirty: opts.allowDirty });
  } catch (err) {
    throw new WorktreeCreationError("validate", (err as Error).message);
  }

  validateWorktreeBranchName(opts.branchName);
  const attached = findExistingWorktree(opts.repoRoot, opts.branchName);
  if (attached) {
    const status = runGit(["status", "--porcelain"], attached.path);
    if (status.status !== 0 || (status.stdout.trim().length > 0 && !opts.allowDirtyAttached)) {
      throw new WorktreeCreationError(
        "branch-collision",
        `branch '${opts.branchName}' already has a dirty attached worktree at ${attached.path}`,
      );
    }
    if (opts.allowDirtyAttached && opts.baseRef) {
      const expectedBaseRef = resolveBaseCommit(opts.repoRoot, opts.baseRef);
      if (attached.head !== expectedBaseRef) {
        reportWorktreeWarning(
          [
            `sf_team: reusing dirty attached worktree for ${opts.branchName} at ${attached.path},`,
            `but its HEAD ${shortSha(attached.head)} differs from expected base ${shortSha(expectedBaseRef)};`,
            "the later merge may require manual recovery.",
          ].join(" "),
          opts.reporter,
        );
      }
    }
    // Reused-lane: still call installDependenciesIfMissing — the existing
    // worktree might have an empty node_modules from a previous incomplete
    // install. The helper short-circuits cheaply when node_modules is present.
    installForWorktree(attached.path, opts.reporter);
    return {
      worktreePath: attached.path,
      branch: attached.branch,
      baseRef: attached.head,
      reused: true,
    };
  }

  const picker = opts.pickDir ?? pickWorktreeDir;
  const worktreePath = picker(opts.repoRoot, opts.slug);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const requested = opts.baseRef ?? "HEAD";
  const baseRef = resolveBaseCommit(opts.repoRoot, requested);

  const branchExistsAlready = branchExists(opts.repoRoot, opts.branchName);
  const args = branchExistsAlready
    ? ["worktree", "add", worktreePath, opts.branchName]
    : ["worktree", "add", "-b", opts.branchName, worktreePath, baseRef];
  const r = runGit(args, opts.repoRoot);
  if (r.status !== 0) {
    throw new WorktreeCreationError(
      "git-worktree-add",
      `git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  installForWorktree(worktreePath, opts.reporter);
  return { worktreePath, branch: opts.branchName, baseRef, reused: false };
}

export function validateWorktreeBranchName(branch: string): void {
  const unsafeShell = /[\s~^:?*[\]\\;&|<>(){}!$`'"]/;
  if (
    branch.length === 0
    || branch !== branch.trim()
    || branch.includes("..")
    || branch.includes("//")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || unsafeShell.test(branch)
  ) {
    throw new WorktreeCreationError("validate", `unsafe git branch name for worktree lane: ${JSON.stringify(branch)}`);
  }
}

export function branchExists(repoRoot: string, branch: string): boolean {
  const r = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
  return r.status === 0;
}

function resolveBaseCommit(repoRoot: string, requested: string): string {
  const resolved = runGit(["rev-parse", "--verify", "--quiet", `${requested}^{commit}`], repoRoot);
  if (resolved.status !== 0) {
    throw new WorktreeCreationError(
      "git-worktree-add",
      `cannot resolve base ref '${requested}' in ${repoRoot}`,
    );
  }
  return resolved.stdout.trim();
}

function runGit(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function reportWorktreeWarning(message: string, reporter: WorkflowReporter | undefined): void {
  if (reporter) {
    reporter.message(message, { level: "warning" });
    return;
  }
  console.warn(message);
}

function shortSha(value: string): string {
  return value.slice(0, 12) || "?";
}

function installForWorktree(worktreePath: string, reporter: WorkflowReporter | undefined): void {
  if (reporter) installDependenciesIfMissing(worktreePath, reporter);
  else installDependenciesIfMissing(worktreePath);
}
