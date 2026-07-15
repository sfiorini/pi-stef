import { removeWorktree } from "./cleanup.js";
import { WorktreeError } from "./validate.js";

/**
 * Finalize a flow implement run: remove the worktree DIRECTORY but
 * PRESERVE the `flow/<slug>` branch so it can be used to open a PR.
 *
 * Deliberately does NOT merge into a base branch and does NOT delete the
 * branch. The caller starts on `main` and ends with a feature branch ready
 * for review.
 *
 * @param worktreePath Absolute path to the worktree directory to remove.
 * @param cwd Optional working directory for git commands (default: process.cwd()).
 */
export async function finalizeWorktree(worktreePath: string, cwd?: string): Promise<void> {
  if (!worktreePath) {
    throw new WorktreeError("finalizeWorktree: worktreePath is required");
  }
  await removeWorktree(worktreePath, cwd);
}
