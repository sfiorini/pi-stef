import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowCheckpointRuntime,
  WorkflowReporter,
} from "@pi-stef/agent-workflows";

import type { ResolvedDefaults } from "../config/schema";
import {
  TASK_WORKFLOW_PROFILE,
  composeDeveloperBrief,
  composeDevRevise,
  runTaskWorkflow,
} from "./run-task-workflow";
import { defaultDeps, type ToolDeps } from "./shared";
import {
  runLegacyVerificationSync,
  type FhTeamVerificationConfigInput,
} from "./verification-stage";
import type { FhTeamTaskInput, FhTeamTaskResult } from "./task-types";

export type { FhTeamTaskInput, FhTeamTaskResult } from "./task-types";
export { composeDeveloperBrief, composeDevRevise } from "./run-task-workflow";

/**
 * fh_team_task: full end-to-end single-task workflow.
 *
 * 1. plan-review (planner -> reviewer loop with revise callback)
 * 2. dirty-worktree guard (unless --allow-dirty)
 * 3. baseline captured by runOrchestrator (use_worktree=false)
 * 4. developer-impl + strict staging
 * 5. impl-review loop with revise callback (developer re-spawn)
 * 6. configured verification hook after reviewer/developer convergence
 * 7. commit + push decision + pr-description
 *
 * The body lives in `runTaskWorkflow` (run-task-workflow.ts) so
 * `fh_team_followup` can share the same lifecycle. This factory just
 * passes the task profile through and forwards the result.
 */
export function createFhTeamTask(rawDeps: Partial<ToolDeps> = {}) {
  const deps: ToolDeps = { ...defaultDeps, ...rawDeps };

  return async function fhTeamTask(
    input: FhTeamTaskInput,
    ctx: {
      repoRoot: string;
      signal?: AbortSignal;
      ui?: ExtensionUIContext;
      configDefaults?: ResolvedDefaults;
      toolName?: string;
      planRoot?: string;
      gitMode?: "on" | "off";
      tddMode?: "on" | "off" | "auto";
      rawGitMode?: "auto" | "on" | "off";
      rawTddMode?: "auto" | "on" | "off";
    },
  ): Promise<FhTeamTaskResult> {
    return runTaskWorkflow(deps, input, ctx, { profile: TASK_WORKFLOW_PROFILE });
  };
}

export function runVerification(
  cwd: string,
  verifyCommand: FhTeamTaskInput["verifyCommand"],
  reporter?: WorkflowReporter,
  checkpoints?: WorkflowCheckpointRuntime,
): void {
  runLegacyVerificationSync("fh_team_task", cwd, verifyCommand, reporter, checkpoints);
}

// Re-export the verification-config input type so existing callers keep
// working without chasing the helper file.
export type { FhTeamVerificationConfigInput };
