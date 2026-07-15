import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { validateRepoState, requireInsideWorkTree, WorktreeError } from "./validate.js";

const execFileAsync = promisify(execFile);

export interface CreateWorktreeOptions {
  slug: string;
  branchPrefix?: string;
  baseRef?: string;
  allowDirty?: boolean;
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
  baseSha: string;
}

function validateSlug(slug: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    throw new WorktreeError(
      `Invalid slug "${slug}". Only alphanumeric, dots, hyphens, and underscores allowed.`
    );
  }
}

export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<WorktreeResult> {
  const { slug, branchPrefix = "flow/", baseRef = "HEAD", allowDirty } = opts;
  validateSlug(slug);

  // Validate repo state
  await validateRepoState({ allowDirty });
  const repoRoot = await requireInsideWorkTree();

  const branchName = `${branchPrefix}${slug}`;

  // Check branch doesn't exist
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branchName]);
    throw new WorktreeError(`Branch ${branchName} already exists`);
  } catch (err) {
    if (err instanceof WorktreeError) throw err;
    // Branch doesn't exist — good
  }

  // Resolve base SHA
  const { stdout: baseShaRaw } = await execFileAsync("git", [
    "rev-parse",
    "--verify",
    baseRef,
  ]);
  const baseSha = baseShaRaw.trim();

  // Pick worktree directory (sibling to repo)
  const parentDir = dirname(repoRoot);
  const worktreeDirName = `flow-${slug}`;
  let worktreePath = join(parentDir, worktreeDirName);

  // Handle collision
  let suffix = 2;
  while (existsSync(worktreePath)) {
    worktreePath = join(parentDir, `${worktreeDirName}-${suffix}`);
    suffix++;
  }

  // Create parent if needed
  await mkdir(dirname(worktreePath), { recursive: true });

  // Create worktree
  await execFileAsync("git", [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    baseSha,
  ]);

  return { worktreePath, branchName, baseSha };
}
