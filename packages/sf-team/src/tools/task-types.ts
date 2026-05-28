import type { PlanRevisionMetrics } from "../plan/revision-metrics";
import type { TeamMember } from "../runtime/types";
import type { CostSummary } from "../orchestrator/cost";
import type { SfTeamVerificationConfigInput } from "./verification-stage";

/**
 * Types shared by `task.ts`, `followup.ts`, and `run-task-workflow.ts`.
 * Lives in its own file so the runtime imports don't form a cycle
 * (run-task-workflow.ts -> task.ts -> run-task-workflow.ts).
 */
export interface SfTeamTaskInput {
  title?: string;
  resume?: string;
  brief?: string;
  planner?: TeamMember;
  developer?: TeamMember;
  reviewer?: TeamMember;
  maxRounds?: number;
  /** When true, accept dirty working tree at entry. Default false. */
  allowDirty?: boolean;
  /**
   * Legacy verification command mapped into the configured after hook.
   * Set to false to skip (test fixtures use this).
   */
  verifyCommand?: { cmd: string; args: string[] } | false;
  verification?: SfTeamVerificationConfigInput;
  /**
   * Push decision callback. Returns `true` to push, `false` to skip,
   * `undefined` to use the default (skip). Defaults to skip when omitted.
   */
  shouldPush?: () => Promise<boolean> | boolean;
}

export interface SfTeamTaskResult {
  slug: string;
  approved: boolean;
  rounds: { plan: number; impl: number };
  commitSha?: string;
  prDescriptionPath?: string;
  performanceReportPath?: string;
  costSummary?: CostSummary;
  pushed: boolean;
  revisionMetrics: PlanRevisionMetrics[];
}
