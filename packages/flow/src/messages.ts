/**
 * Result-message builders for flow tools.
 *
 * The implement/auto tools return directive-first messages that make the
 * agent CONTINUE in the same turn (cd into the worktree / read the skill file),
 * with factual context demoted to a Context block.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to an internal flow skill doc (loaded by tools via `read`; NOT pi-discovered — see pi.skills: []). */
export function skillDocPath(name: string): string {
  return join(pkgRoot, "skills", name, "SKILL.md");
}

export interface ImplementReadyInput {
  slug: string;
  worktreePath: string;
  reviewerModel: string | null;
  developerModel: string | null;
  planPath: string;
}

export function buildImplementReadyMessage(opts: ImplementReadyInput): string {
  const reviewerLine = opts.reviewerModel
    ? `Reviewer model: ${opts.reviewerModel}`
    : "Reviewer model: inherits from parent (not configured)";
  const developerLine = opts.developerModel
    ? `Developer model: ${opts.developerModel}`
    : "Developer model: inherits from parent (not configured)";
  return [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `1. Run: cd ${opts.worktreePath}`,
    `2. Read and execute the skill file at ${skillDocPath("sf-flow-implement")} in full: implement`,
    `   every milestone with the TDD→review→commit→tracker loop, then call`,
    `   sf_flow_finalize with worktree_path "${opts.worktreePath}".`,
    `   Do not stop between milestones or ask for confirmation.`,
    ``,
    `Context:`,
    `- ${reviewerLine}`,
    `- ${developerLine}`,
    `- Plan path: ${opts.planPath}`,
  ]
    .join("\n")
    .replace(/\n+$/g, "\n");
}

export interface AutoReadyInput {
  workflowName: string;
  inputSummary: string;
  /** Absolute path resolved by `resolveWorkflowPath` (project override → global). */
  resolvedWorkflowPath: string;
}

export function buildAutoReadyMessage(opts: AutoReadyInput): string {
  return [
    `Running flow "${opts.workflowName}" end-to-end.`,
    `Input: ${opts.inputSummary}`,
    `Workflow file: ${opts.resolvedWorkflowPath}`,
    `No human gates — phases run to completion or a terminal state.`,
    `Now read the skill file at ${skillDocPath("sf-flow-auto")}.`,
  ].join("\n");
}
