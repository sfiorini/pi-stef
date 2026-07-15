/**
 * Result-message builders for flow tools.
 *
 * The implement/auto tools return directive-first messages that make the
 * agent CONTINUE in the same turn (cd into the worktree / load the skill),
 * with factual context demoted to a Context block.
 */

export interface ImplementReadyInput {
  slug: string;
  worktreePath: string;
  reviewerModel: string | null;
  planPath: string;
}

export function buildImplementReadyMessage(opts: ImplementReadyInput): string {
  const reviewerLine = opts.reviewerModel
    ? `Reviewer model: ${opts.reviewerModel}`
    : "Reviewer model: inherits from parent (not configured)";
  return [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `1. Run: cd ${opts.worktreePath}`,
    `2. Load and execute the skill named "sf-flow-implement" in full: implement`,
    `   every milestone with the TDD→review→commit→tracker loop, then call`,
    `   sf_flow_finalize with worktree_path "${opts.worktreePath}".`,
    `   Do not stop between milestones or ask for confirmation.`,
    ``,
    `Context:`,
    `- ${reviewerLine}`,
    `- Plan path: ${opts.planPath}`,
  ]
    .join("\n")
    .replace(/\n+$/g, "\n");
}

export interface AutoReadyInput {
  workflowName: string;
  inputSummary: string;
}

export function buildAutoReadyMessage(opts: AutoReadyInput): string {
  return [
    `Running flow "${opts.workflowName}" end-to-end.`,
    `Input: ${opts.inputSummary}`,
    `No human gates — phases run to completion or a terminal state.`,
    `Now load the skill named "sf-flow-auto".`,
  ].join("\n");
}
