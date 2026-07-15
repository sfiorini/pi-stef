import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Remove a git worktree directory. Used by sf_flow_finalize to clean up
 * the worktree while preserving the branch.
 *
 * @param worktreePath Absolute path to the worktree to remove.
 * @param cwd Optional working directory for the git command (default: process.cwd()).
 */
export async function removeWorktree(worktreePath: string, cwd?: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  } catch {
    // Ignore errors during cleanup
  }
}
