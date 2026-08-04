import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeError } from "./validate.js";

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
  } catch (err) {
    // Report cleanup failures (D10): a silent failure hides state the operator
    // needs (locked worktree, permission error). The branch is preserved either
    // way; the thrown error carries git's stderr so sf_flow_finalize can surface
    // a structured failure.
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : err instanceof Error
          ? err.message
          : String(err);
    throw new WorktreeError(`worktree cleanup failed for ${worktreePath}${detail ? `: ${detail}` : ""}`);
  }
}
