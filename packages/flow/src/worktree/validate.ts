import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export async function requireGitOrThrow(): Promise<void> {
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    throw new WorktreeError("git is not available in PATH");
  }
}

export async function validateRepoState(opts: {
  allowDirty?: boolean;
} = {}): Promise<void> {
  await requireGitOrThrow();

  if (opts.allowDirty) return;

  const { stdout } = await execFileAsync("git", ["status", "--porcelain"]);
  if (stdout.trim().length > 0) {
    throw new WorktreeError(
      "Working tree is dirty. Commit or stash changes before creating a worktree."
    );
  }
}

export async function requireInsideWorkTree(): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (stdout.trim() !== "true") {
    throw new WorktreeError("Not inside a git repository");
  }

  const { stdout: root } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  return root.trim();
}
