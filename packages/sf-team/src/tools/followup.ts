import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  PLAN_FOLDER_ROOT,
  planFolderPathFromRoot,
  readWorkflowMetadata,
  type ResumeAnalysis,
} from "@pi-stef/agent-workflows";

import type { ResolvedDefaults } from "../config/schema";
import {
  FOLLOWUP_WORKFLOW_PROFILE,
  runTaskWorkflow,
  type RunTaskWorkflowCtx,
} from "./run-task-workflow";
import { resolveParentPlan } from "./followup-resolve";
import { resolveToolResume } from "./resume";
import { defaultDeps, type ToolDeps } from "./shared";
import { followupSlug } from "../plan/slug";
import type { SfTeamTaskInput, SfTeamTaskResult } from "./task-types";
import {
  runLegacyVerificationSync,
  type SfTeamVerificationConfigInput,
} from "./verification-stage";
import type {
  WorkflowCheckpointRuntime,
  WorkflowReporter,
} from "@pi-stef/agent-workflows";

// Re-exports so existing callers (tests, downstream tools) stay green
// without chasing the consolidated workflow file.
export type { SfTeamTaskResult } from "./task-types";
export { composeDeveloperBrief, composeDevRevise } from "./run-task-workflow";

export interface SfTeamFollowupInput {
  /** Followup title; combined with date and `followup-` to form the slug. */
  title?: string;
  /** Resume hint (slug or path). Mutually exclusive with `title`. */
  resume?: string;
  brief?: string;
  /** Override the parent plan auto-detection (slug, absolute, or relative path). */
  parentPlan?: string;
  /** Skip dirty-worktree guard (default false). */
  allowDirty?: boolean;
  planner?: import("../runtime/types").TeamMember;
  developer?: import("../runtime/types").TeamMember;
  reviewer?: import("../runtime/types").TeamMember;
  maxRounds?: number;
  /** Verification command override (false skips). */
  verifyCommand?: { cmd: string; args: string[] } | false;
  verification?: SfTeamVerificationConfigInput;
  /** Push decision callback. Default = skip. */
  shouldPush?: () => Promise<boolean> | boolean;
  /** When auto-detect would be ambiguous, let the caller pick. */
  selectFromAmbiguous?: (candidates: string[]) => Promise<string | undefined>;
}

/**
 * sf_team_followup: addresses follow-up issues against a completed plan.
 *
 * Architecture: a followup runs the SAME end-to-end lifecycle as a task
 * (plan-review → developer-impl → impl-review → verification → commit
 * → optional push → pr-description). The only follow-up-specific piece
 * is parent-plan resolution: we look up the parent's milestone-plan and
 * thread it into the planner brief, and we persist the parent slug in
 * `.fh-workflow/workflow.json` for resume.
 *
 * Differences vs the previous implementation:
 *   - Followup writes a **new** plan folder under
 *     `ai_plan/<date>-followup-<title-kebab>/`. There is no overlay file
 *     in the parent's plan folder anymore, no parent pr-description
 *     mutation, and no worktree-reuse path.
 *   - Followup runs in `ctx.repoRoot` on the currently checked-out
 *     branch (mirrors task). Switch branches yourself before invoking.
 *   - Resume reads the parent slug from `workflow.json.parentSlug`
 *     (NOT from input), which `runWorkflow` persisted on the original
 *     start (see agent-workflows S-302).
 */
export function createSfTeamFollowup(rawDeps: Partial<ToolDeps> = {}) {
  const deps: ToolDeps = { ...defaultDeps, ...rawDeps };

  return async function sfTeamFollowup(
    input: SfTeamFollowupInput,
    ctx: {
      repoRoot: string;
      signal?: AbortSignal;
      ui?: ExtensionUIContext;
      configDefaults?: ResolvedDefaults;
      toolName?: string;
      planRoot?: string;
      selectFromAmbiguous?: (candidates: string[]) => Promise<string | undefined>;
      gitMode?: "on" | "off";
      tddMode?: "on" | "off" | "auto";
      rawGitMode?: "auto" | "on" | "off";
      rawTddMode?: "auto" | "on" | "off";
    },
  ): Promise<SfTeamTaskResult> {
    // Resume resolution first: input.resume can be a slug, a relative
    // path, or an absolute path; resolveToolResume normalizes all three.
    const resume = await resolveToolResume({
      repoRoot: ctx.repoRoot,
      toolName: "sf_team_followup",
      input,
      normalField: "title",
      candidatePlanRoots: ctx.planRoot ? [ctx.planRoot] : undefined,
    });
    if (resume) {
      return runFollowupResume(deps, input, ctx, resume);
    }

    // Start path. Resolve the parent (auto-detect latest, an explicit
    // slug, or an explicit path) and load its milestone-plan.
    const parent = await resolveParentPlan(ctx.repoRoot, {
      plan: input.parentPlan,
      selectFromAmbiguous: input.selectFromAmbiguous ?? ctx.selectFromAmbiguous,
      planRoot: ctx.planRoot,
    });
    const parentMilestonePlan = await loadParentMilestonePlan(parent.folder);
    const slug = followupSlug(input.title ?? "followup");

    return runTaskWorkflow(deps, asTaskInput(input), ctx, {
      profile: FOLLOWUP_WORKFLOW_PROFILE,
      slugOverride: slug,
      parentContext: { slug: parent.slug, parentMilestonePlan },
    });
  };
}

async function runFollowupResume(
  deps: ToolDeps,
  input: SfTeamFollowupInput,
  ctx: RunTaskWorkflowCtx & {
    selectFromAmbiguous?: (candidates: string[]) => Promise<string | undefined>;
  },
  resume: ResumeAnalysis,
): Promise<SfTeamTaskResult> {
  const followupSlugValue = resume.target.slug;
  const effectivePlanRoot = resume.metadata?.planRootPath ?? ctx.planRoot;
  const meta = await readWorkflowMetadata(ctx.repoRoot, followupSlugValue, effectivePlanRoot);
  if (!meta) {
    throw new Error(`sf_team_followup: no workflow metadata for "${followupSlugValue}".`);
  }
  if (meta.ownerTool !== "sf_team_followup") {
    throw new Error(
      `sf_team_followup: slug "${followupSlugValue}" is owned by ${meta.ownerTool}, not sf_team_followup.`,
    );
  }
  const parentSlug = meta.parentSlug;
  if (!parentSlug) {
    throw new Error(
      `sf_team_followup: workflow metadata for "${followupSlugValue}" is missing parentSlug. The original start may have failed before metadata was written.`,
    );
  }
  const resolvedPlanRoot = effectivePlanRoot ?? path.join(ctx.repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const parentFolder = planFolderPathFromRoot(resolvedPlanRoot, parentSlug);
  const parentMilestonePlan = await loadParentMilestonePlan(parentFolder);
  return runTaskWorkflow(deps, asTaskInput(input), ctx, {
    profile: FOLLOWUP_WORKFLOW_PROFILE,
    resume,
    parentContext: { slug: parentSlug, parentMilestonePlan },
  });
}

async function loadParentMilestonePlan(parentFolder: string): Promise<string> {
  const file = path.join(parentFolder, "milestone-plan.md");
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `sf_team_followup: parent milestone-plan.md not found at ${file}. ` +
          `Either pass --parentPlan to point at a folder that contains one, or fall back to sf_team_task for a stand-alone change.`,
      );
    }
    throw new Error(
      `sf_team_followup: failed to read parent milestone-plan.md at ${file}: ${(err as Error).message}`,
    );
  }
}

/**
 * Project the followup-specific input shape into the task input shape so
 * `runTaskWorkflow` can consume it. Followup only adds `parentPlan` and
 * `selectFromAmbiguous` on top of the task input; both are consumed
 * before the workflow body runs and don't need to flow further.
 */
function asTaskInput(input: SfTeamFollowupInput): SfTeamTaskInput {
  const {
    parentPlan: _parentPlan,
    selectFromAmbiguous: _selectFromAmbiguous,
    ...rest
  } = input;
  return rest;
}

/**
 * Legacy verification entry point. Mirrors `task.runVerification` so
 * callers that previously poked at the followup verification path still
 * compile. Internally it just dispatches the same legacy code path with
 * the followup tool name.
 */
export function runVerification(
  cwd: string,
  verifyCommand: SfTeamFollowupInput["verifyCommand"],
  reporter?: WorkflowReporter,
  checkpoints?: WorkflowCheckpointRuntime,
): void {
  runLegacyVerificationSync("sf_team_followup", cwd, verifyCommand, reporter, checkpoints);
}
