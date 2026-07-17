/**
 * Result-message builders for pair tools.
 *
 * The implement tool creates a worktree (a sibling directory to the repo)
 * and returns a message that must make the agent CONTINUE in the same turn:
 * `cd` into the worktree and execute the sf-pair-implement skill to
 * completion. A passive "here is what to do" framing caused agents to stop
 * after the tool call, so these messages lead with an explicit directive.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to an internal pair skill doc (loaded by tools via `read`; NOT pi-discovered — see pi.skills: []). */
export function skillDocPath(name: string): string {
  return join(pkgRoot, "skills", name, "SKILL.md");
}

export interface ImplementReadyInput {
  /** Resolved reviewer model (e.g. "anthropic/claude-opus-4-8"). */
  reviewerModel: string;
  /** The plan folder path/slug the user passed. */
  planPath: string;
  /** Absolute path to the created worktree directory. */
  worktreePath: string;
  /** Worktree branch name (e.g. "pair/<slug>"). */
  branchName: string;
  /** Base SHA the worktree was created from. */
  baseSha: string;
  /** Optional agent-setup warnings to surface (e.g. stale project agent file). */
  warnings?: string[];
}

/**
 * Build the `sf_pair_implement` tool's result text: a directive-first
 * message that tells the agent to `cd` into the worktree and run the
 * sf-pair-implement skill in full, with factual context demoted to a
 * Context block.
 */
export function buildImplementReadyMessage(input: ImplementReadyInput): string {
  const {
    reviewerModel,
    planPath,
    worktreePath,
    branchName,
    baseSha,
    warnings = [],
  } = input;

  const warningBlock = warnings.length > 0
    ? `\n\n⚠️ Agent warning:\n${warnings.map((w) => `- ${w}`).join("\n")}`
    : "";

  return [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `1. Run: cd ${worktreePath}`,
    `2. Read and execute the skill file at ${skillDocPath("sf-pair-implement")} in full: implement`,
    `   every milestone with the TDD→review→commit→tracker loop, then call`,
    `   sf_pair_finalize with worktree_path "${worktreePath}".`,
    `   Do not stop between milestones or ask for confirmation.`,
    ``,
    `Context:`,
    `- Reviewer model: ${reviewerModel}`,
    `- Plan path: ${planPath}`,
    `- Branch: ${branchName} (base ${baseSha})`,
    warningBlock,
  ]
    .join("\n")
    .replace(/\n+$/g, "\n");
}
