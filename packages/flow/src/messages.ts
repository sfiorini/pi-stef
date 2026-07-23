/**
 * Result-message builders for flow tools.
 *
 * The implement/auto tools return directive-first messages that make the
 * agent CONTINUE in the same turn (cd into the worktree / read the skill file),
 * with factual context demoted to a Context block.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { ResolvedModels } from "./config/schema.js";

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
  /** Pre-generated pi-dw script (skill phases run INLINE — no general-purpose twin). Optional so legacy callers/tests omit it. */
  script?: string;
  /** Resolved models, rendered as a reference table for the orchestrator. Optional. */
  models?: ResolvedModels | null;
}

export function buildAutoReadyMessage(opts: AutoReadyInput): string {
  const lines: string[] = [
    `Running flow "${opts.workflowName}" end-to-end.`,
    `Input: ${opts.inputSummary}`,
    `Workflow file: ${opts.resolvedWorkflowPath}`,
    `No human gates — phases run to completion or a terminal state.`,
  ];
  if (opts.script) {
    lines.push(``);
    lines.push(
      `The tool already generated the pi-dw orchestration script below. Skill phases run INLINE — YOU are the orchestrator: read + execute each skill file in full, dispatch role agents via the Agent tool, write NO code yourself, and spawn NO general-purpose subagent for a skill phase.`,
    );
    lines.push(``);
    lines.push("```js");
    lines.push(opts.script);
    lines.push("```");
  }
  if (opts.models) {
    lines.push(``);
    lines.push(`Resolved models (config; inherit the orchestrator when null):`);
    lines.push(`- reviewer: ${opts.models.reviewerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- researcher: ${opts.models.researcherModel ?? "(inherit orchestrator)"}`);
    lines.push(`- developer: ${opts.models.developerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- planner: ${opts.models.plannerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- auditor: ${opts.models.auditorModel ?? "(inherit orchestrator)"}`);
    lines.push(`- synth: ${opts.models.synthModel ?? "(inherit orchestrator)"}`);
    lines.push(`- designer: ${opts.models.designerModel ?? "(inherit orchestrator)"}`);
  }
  lines.push(``);
  lines.push(`Now read the skill file at ${skillDocPath("sf-flow-auto")}.`);
  return lines.join("\n").replace(/\n+$/g, "\n");
}
