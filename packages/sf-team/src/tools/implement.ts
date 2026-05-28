import { spawnSync } from "node:child_process";
import type { WorkflowCheckpointRuntime, WorkflowReporter, WorkflowToolName } from "@pi-stef/agent-workflows";

import { EmptyDiffError, SfTeamToolError, IncompatibleModeError, MergeFailedError, WorkflowStateError } from "../errors";
import { runOrchestrator } from "../orchestrator/run";
import { generatePrDescription } from "../orchestrator/pr-description";
import { createWorktree, ensureLaneWorktree } from "../worktree/create";
import { requireGitOrSkip } from "../worktree/validate";
import { mergeBranchIntoWorktree } from "../worktree/merge";
import { removeRolledUpWorktree, tryDeleteBranch, type BranchCleanupWarning } from "../worktree/cleanup";
import { type ParsedMilestone, type ParsedStory, updateMilestoneApproval, updateStoryTracker } from "../plan/tracker";
import { detectPackageManager, packageScriptsAt } from "../runtime/package-manager";
import { DEFAULT_CONFIG, type ResolvedDefaults } from "../config/schema";
import { effectiveTmuxManager, effectiveUi, implementationReviewMaxRounds, workflowProfile } from "../config/workflow";
import type { TeamMember } from "../runtime/types";
import { composeImplSummary, composeImplVerifyFixesPrompt } from "./impl-summary";
import { normalOrResumeValue, resolveToolResume } from "./resume";
import { composeDeveloperSystemPreamble, defaultDeps, makeReviewer, makeRunStringReviewLoop, makeSpawnHelper, runLoopWithPartialOutput, type ToolDeps } from "./shared";
import { pendingMilestones, readImplementPlanFolder } from "./implement-reader";
import { planExecutionWaves, type ExecutionSchedule, type ScheduledMilestoneBatch, type ScheduledMilestoneLane, type ScheduledStoryLane } from "./execution-scheduler";
import { REVIEWER_TDD_POLICY, composeTddContract } from "./tdd-policy";
import { runConfiguredVerification, runLegacyVerificationSync, type SfTeamVerificationConfigInput } from "./verification-stage";
import type { CostSummary } from "../orchestrator/cost";
import { runVerificationGateWithFixLoop } from "./verification-gate-loop";
import { decideSteeringInstruction, decideSteeringInstructions } from "../steering/decider";
import { enforcePauseAtSafeBoundary } from "../steering/pause-enforcement";
import { applySteeringBacktrack } from "../steering/backtrack";

export { detectPackageManager, packageScriptsAt } from "../runtime/package-manager";

export type ImplementMode = "single-milestone" | "all-milestones";

export interface SfTeamImplementInput {
  /** Slug under ai_plan/ that holds the 5-file plan folder. */
  slug?: string;
  resume?: string;
  developer?: TeamMember;
  reviewer?: TeamMember;
  maxRounds?: number;
  /** D1 (single-milestone) is default; D2 (all-milestones) for sf_team_auto. */
  mode?: ImplementMode;
  /** When true (default), create a worktree at start. */
  useWorktree?: boolean;
  /** Branch prefix for the new branch (default 'implement/'). */
  branchPrefix?: string;
  /** Optional repo override (test fixtures). */
  repoRoot?: string;
  /** Optional verifyCommand override (false = skip). */
  verifyCommand?: { cmd: string; args: string[] } | false;
  verification?: SfTeamVerificationConfigInput;
  /**
   * Inter-milestone pause. When `true` and `ctx.ui` is present, the
   * orchestrator calls `ctx.ui.confirm(title, message)` between milestones
   * and stops the loop on a `false` response. When `false`, milestones run
   * end-to-end. When omitted, falls through to
   * `ctx.configDefaults?.implement.pause_between_milestones` (default `true`
   * for `sf_team_implement`, `false` for `sf_team_auto`). Headless runs
   * (`!ctx.ui`) treat `true` as `false` with a `console.warn`.
   */
  pauseBetweenMilestones?: boolean;
  /**
   * D1 user-gate callback (TEST-ONLY). Production tool registration MUST
   * NOT inject a default callback — the `pauseBetweenMilestones` config
   * knob is the single source of truth for production runs. When this
   * callback IS provided (e.g. by a test), it OVERRIDES the config knob
   * and is called after every approved milestone with the milestone id;
   * return `false` to stop, `true` to continue.
   *
   * Documented as test-only in JSDoc but kept as an opt-in escape hatch.
   */
  shouldContinue?: (milestoneId: string) => Promise<boolean> | boolean;
}

export interface MilestoneOutcome {
  id: string;
  approved: boolean;
  rounds: number;
  commitSha?: string;
}

export interface SfTeamImplementResult {
  slug: string;
  mode: ImplementMode;
  worktreePath?: string;
  branch?: string;
  milestones: MilestoneOutcome[];
  prDescriptionPath?: string;
  performanceReportPath?: string;
  costSummary?: CostSummary;
  /**
   * Non-fatal lane-branch cleanup outcomes from M4. Populated by parallel
   * runs only — sequential runs never create lane branches and so this
   * stays empty/undefined. Each entry is a discriminated union member of
   * `BranchCleanupWarning`. Cleanup failures NEVER throw — they always
   * append a warning here so the run completes.
   */
  warnings?: BranchCleanupWarning[];
}

export type { BranchCleanupWarning } from "../worktree/cleanup";

/**
 * sf_team_implement: read plan folder -> optional worktree -> for each
 * pending milestone: developer-impl -> impl-review loop -> configured
 * verification hook -> commit -> inter-milestone gate -> next; final
 * pr-description.
 *
 * Inter-milestone gate (M2): independent of `mode`. When the resolved
 * `pauseBetweenMilestones` is true and a UI is present, the orchestrator
 * calls `ctx.ui.confirm(...)` between milestones; on a `false` answer it
 * stops with whatever was approved so far. When the resolved value is
 * false, the loop runs end-to-end without prompting. The gate is also
 * skipped after the LAST milestone (nothing to continue to).
 *
 * Resolution order for `pauseBetweenMilestones`:
 *   prompt arg → `ctx.configDefaults?.implement.pause_between_milestones`
 *   → `DEFAULT_CONFIG.implement.pause_between_milestones` (true).
 *
 * `sf_team_auto` calls this same path with the `auto.*` config (default
 * `false`) so the auto wrapper runs end-to-end unless the user explicitly
 * opts in.
 *
 * Mode (`single-milestone`/`all-milestones`) currently selects the
 * developer-spawn cardinality but does NOT affect the gate.
 */
export function createSfTeamImplement(rawDeps: Partial<ToolDeps> = {}) {
  const deps: ToolDeps = { ...defaultDeps, ...rawDeps };
  const runLoop = makeRunStringReviewLoop(deps);

  return async function sfTeamImplement(
    input: SfTeamImplementInput,
    ctx: {
      repoRoot: string;
      signal?: AbortSignal;
      ui?: import("@earendil-works/pi-coding-agent").ExtensionUIContext;
      configDefaults?: ResolvedDefaults;
      /** Forwarded to runOrchestrator; set by `sf_team_auto` so plan + implement decorate the same tmux session. */
      tmuxSessionAliasOverride?: string;
      resumeOwnerTool?: WorkflowToolName;
      tmuxManager?: import("../tmux/manager").TmuxManager | null;
      tmuxSessionName?: string;
      /**
       * Pi tool name that fronts this run (`sf_team_implement`,
       * `sf_team_implement_resume`, `sf_team_auto`, …). Used by typed
       * errors so `Error.message` carries the right `FAILED: <toolName>`
       * surface. When called by `sf_team_auto`, this is set to the
       * implement-side surface (`sf_team_implement`); auto's outer
       * try/catch then `withTool(...)` rewraps for the auto tool name.
       */
      toolName?: string;
      tddMode?: "on" | "off" | "auto";
      gitMode?: "on" | "off";
      /** Resolved planRoot for resume discovery cascade. */
      planRoot?: string;
      /** Raw prompt value for gitMode before runtime resolution; used for resume precedence. */
      rawGitMode?: "auto" | "on" | "off";
      /** Raw prompt value for tddMode before runtime resolution; used for resume precedence. */
      rawTddMode?: "auto" | "on" | "off";
    },
  ): Promise<SfTeamImplementResult> {
    const repoRoot = input.repoRoot ?? ctx.repoRoot;
    // Preflight: this workflow always does git operations (worktree create
    // and/or commit/diff) in git mode. Fail fast with a friendly message
    // BEFORE spawning any agent so the user doesn't burn planner / reviewer
    // tokens against a non-git folder. In no-git mode, skip this check.
    // Note: effectiveGitMode is computed after resolveToolResume, so we use ctx.gitMode
    // for the preflight check here. If gitMode='on' and cwd is non-git, this throws
    // immediately. If gitMode='off' (or auto-resolved off), it skips.
    const resume = await resolveToolResume({
      repoRoot,
      toolName: ctx.resumeOwnerTool ?? "sf_team_implement",
      input,
      normalField: "slug",
      candidatePlanRoots: ctx.planRoot ? [ctx.planRoot] : undefined,
    });
    // Resume precedence: persisted gitMode/tddMode wins unless the user
    // explicitly passed 'on' or 'off' in the prompt.
    const effectiveGitMode: "on" | "off" =
      resume?.metadata?.gitMode != null && (ctx.rawGitMode === undefined || ctx.rawGitMode === "auto")
        ? resume.metadata.gitMode
        : (ctx.gitMode ?? "on");
    const effectiveTddMode: "on" | "off" | "auto" =
      resume?.metadata?.tddMode != null && (ctx.rawTddMode === undefined || ctx.rawTddMode === "auto")
        ? resume.metadata.tddMode
        : (ctx.tddMode ?? "auto");
    // effectivePlanRoot: if the resume was found via global index, its planRootPath
    // points to the actual location; prefer that over the prompt-resolved ctx.planRoot.
    const effectivePlanRoot = resume?.metadata?.planRootPath ?? ctx.planRoot;
    // Preflight git check uses the effective mode (which may come from persisted workflow.json)
    // so a slug-only resume from a non-git cwd of a no-git workflow doesn't fail here.
    requireGitOrSkip({ repoRoot, gitMode: effectiveGitMode }, "sf_team_implement");
    const slug = normalOrResumeValue(input, "slug", resume);
    const agents = ctx.configDefaults?.agents ?? DEFAULT_CONFIG.agents;
    const developer = input.developer ?? defaultDev(agents);
    const reviewer = input.reviewer ?? defaultReviewer(agents);
    const ui = effectiveUi(ctx.ui, ctx.configDefaults);
    const maxRounds = implementationReviewMaxRounds(input.maxRounds, ctx.configDefaults);
    // Resolution: prompt arg → config (`implement.*`) → default.
    // In no-git mode, useWorktree is forced to false (no git repo = no worktree).
    // If the caller explicitly passed useWorktree=true with gitMode='off', that's
    // an incompatible combination — throw IncompatibleModeError immediately.
    const mode: ImplementMode = input.mode ?? ctx.configDefaults?.implement.mode ?? "single-milestone";
    if (effectiveGitMode === "off" && input.useWorktree === true) {
      throw new IncompatibleModeError({
        toolName: ctx.toolName ?? "sf_team_implement",
        kind: "incompatible_mode",
        description: "useWorktree: true is incompatible with gitMode: off",
        resumeHint: "set useWorktree: false or remove gitMode: off",
        details: {},
      });
    }
    const useWorktree = effectiveGitMode === "off"
      ? false
      : (input.useWorktree ?? ctx.configDefaults?.implement.use_worktree ?? true);
    const pauseBetweenMilestones =
      input.pauseBetweenMilestones
        ?? ctx.configDefaults?.implement.pause_between_milestones
        ?? DEFAULT_CONFIG.implement.pause_between_milestones;

    const orchestrated = await runOrchestrator(
      {
        repoRoot,
        slug,
        planRoot: effectivePlanRoot,
        toolName: "sf_team_implement",
        ownerTool: ctx.resumeOwnerTool,
        allowOwnerTakeoverFrom: resume ? undefined : ["sf_team_plan"],
        useWorktree,
        gitMode: effectiveGitMode,
        tddMode: effectiveTddMode,
        signal: ctx.signal,
        ui,
        tmuxManager: effectiveTmuxManager(ctx.tmuxManager, ctx.configDefaults),
        tmuxSessionName: ctx.tmuxSessionName,
        tmuxSessionAliasOverride: ctx.tmuxSessionAliasOverride,
        workflowProfile: workflowProfile(ctx.configDefaults),
        resumeMode: !!resume,
        reviewRoundLimits: {
          maxRounds: ctx.configDefaults?.review.max_rounds ?? DEFAULT_CONFIG.review.max_rounds,
          planMaxRounds: ctx.configDefaults?.review.plan_max_rounds ?? DEFAULT_CONFIG.review.plan_max_rounds,
          implementationMaxRounds: maxRounds,
        },
        widgetUpdateIntervalMs: ctx.configDefaults?.performance.widget_update_interval_ms
          ?? DEFAULT_CONFIG.performance.widget_update_interval_ms,
      },
      async (bodyCtx) => {
        // sf_team_implement starts directly in the implementation phase
        // (no planner stage). Switch the transcript handle so every entry
        // — including resume system notes — lands under
        // transcript/implementation/.
        bodyCtx.transcript.setPhase("implementation");
        const sp = makeSpawnHelper(deps, {
          recordRun: bodyCtx.recordRun,
          subscribeAgent: bodyCtx.subscribeAgent,
          checkpoints: bodyCtx.checkpoints,
          steering: bodyCtx.steering,
        });
        bodyCtx.steering.setDecider((deciderInput) =>
          decideSteeringInstruction(deciderInput, {
            sp,
            member: { ...reviewer, role: "steering-decider", skills: [] },
            cwd: repoRoot,
            signal: bodyCtx.signal,
          })
        );
        bodyCtx.steering.setBatchDecider((batchInput) =>
          decideSteeringInstructions(batchInput, {
            sp,
            member: { ...reviewer, role: "steering-decider", skills: [] },
            cwd: repoRoot,
            signal: bodyCtx.signal,
          })
        );
        bodyCtx.steering.setPlanDecisionApplier(({ instruction, decision }) =>
          applySteeringBacktrack({
            repoRoot,
            slug,
            workflowId: bodyCtx.steering.workflowId,
            instruction,
            decision,
            planner: { role: "planner", model: reviewer.model, thinking: reviewer.thinking, skills: [] },
            sp,
            transcript: bodyCtx.transcript,
            signal: bodyCtx.signal,
            // M5 deliberately runs production backtracking as forward-only
            // rework until a durable per-story commit ledger exists. The
            // steering/backtrack module still exposes ownership-aware revert
            // planning for tests and future ledger integration.
            confirmCompletedWork: ui
              ? async (summary) => await ui.confirm("Backtrack completed sf-team work?", summary.message, { signal: bodyCtx.signal }) === true
              : undefined,
          })
        );
        await bodyCtx.steering.drain("workflow-start");
        await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });
        // S-B01: read plan folder.
        const folder = await readImplementPlanFolder(repoRoot, slug, effectivePlanRoot);
        const todo = pendingMilestones(folder.milestones);
        const parallelDefaults = ctx.configDefaults?.parallel ?? DEFAULT_CONFIG.parallel;
        const shouldUseParallel =
          useWorktree
          && parallelDefaults.enabled
          && folder.executionStrategy.source !== "sequential-fallback"
          && strategyHasParallelWork(folder.executionStrategy);

        // S-B02: optional worktree.
        let worktreePath: string | undefined;
        let branch: string | undefined;
        let cwd = repoRoot;
        if (useWorktree) {
          const branchPrefix = input.branchPrefix ?? ctx.configDefaults?.implement.branch_prefix ?? "implement/";
          const branchName = `${branchPrefix}${slug}`;
          const created = shouldUseParallel || resume
            ? await ensureLaneWorktree({
              repoRoot,
              slug,
              branchName,
              allowDirty: true,
              allowDirtyAttached: !!resume,
              reporter: bodyCtx.reporter,
            })
            : await createWorktree({
              repoRoot,
              slug,
              branchPrefix,
              allowDirty: true, // the parent repo may have unrelated edits; the child is isolated
              reporter: bodyCtx.reporter,
            });
          worktreePath = created.worktreePath;
          branch = created.branch;
          cwd = created.worktreePath;
        }
        bodyCtx.steering.setDecider((deciderInput) =>
          decideSteeringInstruction(deciderInput, {
            sp,
            member: { ...reviewer, role: "steering-decider", skills: [] },
            cwd,
            signal: bodyCtx.signal,
          })
        );
        bodyCtx.steering.setBatchDecider((batchInput) =>
          decideSteeringInstructions(batchInput, {
            sp,
            member: { ...reviewer, role: "steering-decider", skills: [] },
            cwd,
            signal: bodyCtx.signal,
          })
        );

        if (shouldUseParallel && branch) {
          const schedule = planExecutionWaves({
            strategy: folder.executionStrategy,
            milestones: folder.milestones,
            parallel: parallelDefaults,
            mode,
            signal: bodyCtx.signal,
          });
          const piToolName = ctx.toolName ?? "sf_team_implement";
          const resumeTool = resolveResumeTool(piToolName);
          const emptyDiffRetries = resolveEmptyDiffRetries(piToolName, ctx.configDefaults);
          const emptyDiffRetryModel = resolveEmptyDiffRetryModel(piToolName, ctx.configDefaults);
          const keepLaneBranches = ctx.configDefaults?.parallel.keep_lane_branches
            ?? DEFAULT_CONFIG.parallel.keep_lane_branches;
          const { outcomes, warnings: cleanupWarnings } = await runParallelSchedule(schedule, {
            repoRoot,
            slug,
            planRoot: effectivePlanRoot,
            toolName: piToolName,
            resumeTool,
            emptyDiffRetries,
            emptyDiffRetryModel,
            keepLaneBranches,
            aggregateCwd: cwd,
            aggregateBranch: branch,
            developer,
            reviewer,
            maxRounds,
            milestonePlan: folder.milestonePlan,
            sp,
            runLoop,
            verifyCommand: input.verifyCommand,
            verification: input.verification ?? ctx.configDefaults?.implement.verification,
            signal: bodyCtx.signal,
            transcript: bodyCtx.transcript,
            clearAgents: bodyCtx.clearAgents,
            reporter: bodyCtx.reporter,
            checkpoints: bodyCtx.checkpoints,
            verificationCache: bodyCtx.verificationCache,
            verificationCachePath: bodyCtx.verificationCachePath,
            verificationAgent: {
              member: reviewer,
              // Route through makeSpawnHelper so steering guidance is
              // injected into the verifier-agent prompt alongside other
              // non-decider spawns.
              spawnAgent: (member, task) => sp.spawn(member, task, member.role),
            },
            pauseBetweenMilestones,
            shouldContinue: input.shouldContinue,
            ui,
            resumeMode: !!resume,
            steering: bodyCtx.steering,
            tddMode: effectiveTddMode,
            gitMode: effectiveGitMode,
          });
          // Skip PR description in no-git mode.
          const prDescriptionPath = effectiveGitMode !== "off"
            ? await generatePrDescription({
              repoRoot,
              slug,
              title: slug,
              gitRange: `main..${branch}`,
            })
            : undefined;
          return {
            slug,
            mode,
            worktreePath,
            branch,
            milestones: outcomes,
            prDescriptionPath,
            warnings: cleanupWarnings.length > 0 ? cleanupWarnings : undefined,
          } satisfies SfTeamImplementResult;
        }

        const outcomes: MilestoneOutcome[] = [];

        // S-B03 / S-B04: per-milestone or single-developer flow.
        // We use the same loop in both modes; D2 simply skips the gate.
        const piToolName = ctx.toolName ?? "sf_team_implement";
        const resumeTool = resolveResumeTool(piToolName);
        const emptyDiffRetries = resolveEmptyDiffRetries(piToolName, ctx.configDefaults);
        const emptyDiffRetryModel = resolveEmptyDiffRetryModel(piToolName, ctx.configDefaults);
        for (const milestone of todo) {
          await bodyCtx.steering.drain("before-agent-spawn");
          let result!: MilestoneOutcome;
          try {
            result = await runMilestone(milestone, {
              cwd,
              tddMode: effectiveTddMode,
              gitMode: effectiveGitMode,
              toolName: piToolName,
              resumeTool,
              slug,
              emptyDiffRetries,
              emptyDiffRetryModel,
              developer,
              reviewer,
              maxRounds,
              milestonePlan: folder.milestonePlan,
              sp,
              runLoop,
              verifyCommand: input.verifyCommand,
              verification: input.verification ?? ctx.configDefaults?.implement.verification,
              signal: bodyCtx.signal,
              // Per-milestone subfolder so each milestone's last-draft.md doesn't clobber siblings.
              partialOutputCtx: { repoRoot, slug, subfolder: milestone.id },
              transcript: bodyCtx.transcript,
              clearAgents: bodyCtx.clearAgents,
              reporter: bodyCtx.reporter,
              checkpoints: bodyCtx.checkpoints,
              verificationCache: bodyCtx.verificationCache,
              verificationCachePath: bodyCtx.verificationCachePath,
              verificationAgent: {
              member: reviewer,
              // Route through makeSpawnHelper so steering guidance is
              // injected into the verifier-agent prompt alongside other
              // non-decider spawns.
              spawnAgent: (member, task) => sp.spawn(member, task, member.role),
            },
            });
          } finally {
            await bodyCtx.steering.drain("agent-ended");
          }
          outcomes.push(result);
          if (!result.approved) break;

          // Record approval back to story-tracker.md so resuming a half-done
          // run picks up at the next milestone (and PR summary stays fresh).
          await bodyCtx.steering.drain("before-milestone-complete");
          await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });
          await markMilestoneCompleted(repoRoot, slug, milestone, result.commitSha, effectivePlanRoot).catch(
            () => undefined,
          );
          await bodyCtx.steering.store
            .expireGuidanceForScope("milestone", milestone.id)
            .catch(() => undefined);

          // Inter-milestone gate. Skipped after the LAST milestone because
          // there is nothing to continue to — asking would be wasted UX.
          // Precedence:
          //   1. Explicit `shouldContinue` callback (test-only escape hatch);
          //      overrides the config knob.
          //   2. Config-driven `pauseBetweenMilestones`. When true AND a UI
          //      is present, `await ctx.ui.confirm(...)`. On false-result,
          //      break the loop. When true AND no UI, warn and continue
          //      (headless safety — test/CI runs cannot hang on a confirm).
          //   3. When false (or all sources are false), continue silently.
          const isLastMilestone = milestone === todo[todo.length - 1];
          if (!isLastMilestone) {
            if (input.shouldContinue) {
              const cont = await input.shouldContinue(milestone.id);
              if (!cont) break;
            } else if (pauseBetweenMilestones) {
              if (ui?.confirm) {
                const cont = await ui.confirm(
                  "Continue to next milestone?",
                  `Milestone ${milestone.id} approved and committed. Proceed?`,
                );
                if (!cont) break;
              } else {
                console.warn(
                  "[sf-team] pause_between_milestones=true but no UI; continuing without prompt",
                );
              }
            }
          }
        }

        // S-B05: pr-description. Skip in no-git mode.
        await bodyCtx.steering.drain("before-final-completion");
        await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });
        const prDescriptionPath = effectiveGitMode !== "off"
          ? await generatePrDescription({
            repoRoot,
            slug,
            title: slug,
            gitRange: branch ? `main..${branch}` : "-1",
          })
          : undefined;

        return {
          slug,
          mode,
          worktreePath,
          branch,
          milestones: outcomes,
          prDescriptionPath,
        } satisfies SfTeamImplementResult;
      },
    );

    const result: SfTeamImplementResult = (
      orchestrated.result ?? {
        slug,
        mode,
        milestones: [],
      }
    );
    if (orchestrated.performanceReportPath) result.performanceReportPath = orchestrated.performanceReportPath;
    if (orchestrated.costSummary) result.costSummary = orchestrated.costSummary;
    return result;
  };
}

interface RunMilestoneCtx {
  cwd: string;
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
  /** Pi tool name fronting this run, used by typed errors. */
  toolName: string;
  /** Tool to suggest in `RESUME:` hints. Defaults to `sf_team_implement_resume`. */
  resumeTool: string;
  /** Slug of the plan folder; included in EmptyDiffError details. */
  slug: string;
  /** Empty-diff retry budget (M3). Default 2; 0 disables retries. */
  emptyDiffRetries: number;
  /**
   * Optional model id to pass to the developer spawn helper on the LAST
   * empty-diff retry only (M3). Unset by default (no model bump).
   */
  emptyDiffRetryModel?: string;
  developer: TeamMember;
  reviewer: TeamMember;
  maxRounds: number;
  milestonePlan: string;
  sp: ReturnType<typeof makeSpawnHelper>;
  runLoop: ReturnType<typeof makeRunStringReviewLoop>;
  verifyCommand: SfTeamImplementInput["verifyCommand"];
  verification?: SfTeamVerificationConfigInput;
  signal?: AbortSignal;
  /** Where to drop last-draft.md / last-review.md if the impl-review loop exhausts rounds. */
  partialOutputCtx: { repoRoot: string; slug: string; subfolder: string };
  /** Per-run transcript for agent-handoff auditing (set by the orchestrator body). */
  transcript: import("../orchestrator/run").OrchestratorBodyContext["transcript"];
  /** Optional widget-clear hook. Called at the start of each milestone so the widget shows only that milestone's agents. */
  clearAgents?: () => void;
  reporter?: WorkflowReporter;
  checkpoints?: WorkflowCheckpointRuntime;
  verificationCache?: import("@pi-stef/agent-workflows").VerificationRunCache;
  verificationCachePath?: string;
  verificationAgent?: {
    member: TeamMember;
    spawnAgent: (member: TeamMember, task: import("../runtime/types").AgentTask) => Promise<import("../runtime/types").AgentRun>;
  };
}

async function runMilestone(milestone: ParsedMilestone, ctx: RunMilestoneCtx): Promise<MilestoneOutcome> {
  // Drop prior milestone's cards (and any plan-phase cards from sf_team_auto)
  // so the widget shows only this milestone's developer + reviewer. Past
  // results live in the transcript folder; the widget is for live activity.
  ctx.clearAgents?.();
  // Developer impl phase.
  const milestoneSlug = sanitizeMilestoneId(milestone.id);
  const devCardId = `developer-${milestoneSlug}`;
  const reviewerCardId = `reviewer-${milestoneSlug}`;
  const widgetOpts = { milestoneId: milestone.id } as const;
  await runConfiguredVerification({
    toolName: "sf_team_implement",
    cwd: ctx.cwd,
    phase: "before",
    verification: ctx.verification,
    legacyVerifyCommand: ctx.verifyCommand,
    reporter: ctx.reporter,
    checkpoints: ctx.checkpoints,
    cache: ctx.verificationCache,
    persistentCachePath: ctx.verificationCachePath,
    agent: ctx.verificationAgent,
  });
  const implOutput = await ctx.sp.spawnText(
    ctx.developer,
    {
      task: composeMilestoneBrief(milestone, ctx.milestonePlan, { cwd: ctx.cwd, tddMode: ctx.tddMode, gitMode: ctx.gitMode }),
      cwd: ctx.cwd,
      signal: ctx.signal,
    },
    `developer impl failed for ${milestone.id}`,
    devCardId,
    widgetOpts,
  );
  await ctx.transcript.record({
    role: "developer",
    label: `impl-output-${sanitizeMilestoneId(milestone.id)}`,
    body: implOutput,
    meta: { milestoneId: milestone.id, length: implOutput.length },
  });

  return reviewMilestoneChanges(milestone, {
    ...ctx,
    developerOutput: implOutput,
    devCardId,
    reviewerCardId,
    widgetOpts,
    diffLabel: `Files changed by milestone ${milestone.id}`,
    commitMessage: `feat(${milestone.id}): ${milestone.title}`,
  });
}

interface ReviewMilestoneChangesCtx extends RunMilestoneCtx {
  developerOutput: string;
  devCardId: string;
  reviewerCardId: string;
  widgetOpts: {
    milestoneId?: string;
    storyId?: string;
    paneGroupId?: string;
    paneLayoutRole?: import("../tmux/manager").PaneLayoutRole;
  };
  diffLabel: string;
  commitMessage: string;
  diffBaseRef?: string;
  allowEmptyCommit?: boolean;
}

async function reviewMilestoneChanges(
  milestone: ParsedMilestone,
  ctx: ReviewMilestoneChangesCtx,
): Promise<MilestoneOutcome> {
  // Capture the round-1 diff (still recorded full into the transcript) and
  // build the originalImplSummary held for the lifetime of the loop.
  // In no-git mode, use the developer's output text as the evidence of changes
  // (no git staging available), bypassing the empty-diff gate entirely.
  let initialDiff: string;
  let activeDeveloperOutput = ctx.developerOutput;
  if ((ctx.gitMode ?? "on") === "off") {
    // No-git mode: use the developer output directly as the "diff" representation.
    initialDiff = ctx.developerOutput;
  } else {
    initialDiff = readReviewDiff(ctx.cwd, ctx.diffBaseRef);
    if (initialDiff.trim().length === 0) {
      const existing = headCommitWithSubject(ctx.cwd, ctx.commitMessage);
      if (existing) return { id: milestone.id, approved: true, rounds: 0, commitSha: existing };

      // M3 S-M33: bounded retry loop. After the developer's first attempt
      // staged nothing, re-prompt up to `emptyDiffRetries` times. On the
      // LAST attempt, if `emptyDiffRetryModel` is configured, pass that
      // model to the spawn helper for a one-shot stronger run.
      const retries = Math.max(0, ctx.emptyDiffRetries);
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        const isLast = attempt === retries;
        const modelOverride = isLast ? ctx.emptyDiffRetryModel : undefined;
        const newOutput = await redoDeveloperWithReprompt(milestone, ctx, attempt, modelOverride);
        const newDiff = readReviewDiff(ctx.cwd, ctx.diffBaseRef);
        if (newDiff.trim().length > 0) {
          // S-M33: replace the held developerOutput so downstream impl-review
          // and the originalImplSummary embed the recovered diff body, not
          // the failed first attempt's text.
          initialDiff = newDiff;
          activeDeveloperOutput = newOutput;
          break;
        }
      }
      if (initialDiff.trim().length === 0) {
        const totalAttempts = 1 + retries;
        const emptyDiffDetails = {
          milestoneId: milestone.id,
          attempts: totalAttempts,
          slug: ctx.slug,
          worktreePath: ctx.cwd,
          resumeTool: ctx.resumeTool,
        };
        await ctx.transcript.record({
          role: "system",
          label: `empty-diff-${sanitizeMilestoneId(milestone.id)}`,
          body: JSON.stringify(emptyDiffDetails, null, 2),
          meta: { milestoneId: milestone.id, kind: "empty_diff", attempts: totalAttempts },
        });
        throw new EmptyDiffError({
          toolName: ctx.toolName,
          milestoneId: milestone.id,
          attempts: totalAttempts,
          slug: ctx.slug,
          worktreePath: ctx.cwd,
          resumeTool: ctx.resumeTool,
        });
      }
    }
  }
  const initialDiffStat = readReviewDiffStat(ctx.cwd, ctx.diffBaseRef);
  // Transcript still gets the FULL diff body — the user explicitly wants the
  // complete files in transcripts for human reference. Only the reviewer
  // payload is summary-based.
  await ctx.transcript.record({
    role: "developer",
    label: `impl-diff-${sanitizeMilestoneId(milestone.id)}`,
    body: initialDiff,
    meta: { milestoneId: milestone.id, length: initialDiff.length },
  });

  // Build the round-1 reviewer payload (also serves as `originalImplSummary`
  // for every round 2+ prompt — held in this closure so round 3, 4, … all
  // embed the round-1 summary verbatim regardless of `runReviewLoop`'s
  // immediately-previous-round prior tracking).
  const milestoneSlugForTranscripts = sanitizeMilestoneId(milestone.id);
  const implOutputTranscriptName = `developer-impl-output-${milestoneSlugForTranscripts}`;
  const implDiffTranscriptName = `developer-impl-diff-${milestoneSlugForTranscripts}`;
  const originalImplSummary = composeImplSummary({
    // Use the *active* developer output — when a retry recovered the
    // empty-diff failure, this is the recovered run's text rather than
    // the failed first attempt's. (M3 S-M33: replace held output on retry
    // success.)
    finalText: activeDeveloperOutput,
    diffStat: initialDiffStat,
    diffBody: initialDiff,
    label: ctx.diffLabel,
    transcriptHints: { implOutputName: implOutputTranscriptName, implDiffName: implDiffTranscriptName },
  });

  // Track the most recent reviewer verdict's transcript filename so the
  // round-N+1 prompt's `priorVerdictName` truncation marker (if it fires)
  // points at the right file.
  let lastReviewerTranscriptName: string | undefined;

  // Impl-review loop.
  const innerReviewer = makeReviewer(
    ctx.sp.spawnText,
    ctx.reviewer,
    (payload, prior) => {
      // Round 1: payload IS the originalImplSummary (initialPayload). The
      // prompt is a thin lead-in followed by the summary body. The reviewer
      // is told it can spot-check specific files via its read tools.
      if (!prior) {
        const stateLine = ctx.diffBaseRef
          ? `The implementation is committed on this lane branch as the diff from ${ctx.diffBaseRef} to HEAD; any reviewer-requested revision should be staged by the developer before the final milestone approval commit.`
          : "The implementation is staged but NOT yet committed there.";
        return [
          `Review the implementation of milestone ${milestone.id}.`,
          "",
          `If you want to inspect specific files mentioned in the summary, your read/grep/find/ls tools operate on the current working directory (${ctx.cwd}); ${stateLine} Use this for spot-checks; do not enumerate every changed file.`,
          "",
          payload,
          REVIEWER_TDD_POLICY({ tddMode: ctx.tddMode, gitMode: ctx.gitMode }),
        ].join("\n");
      }
      // Round 2+: payload is the round-N currentFixSummary (built by `revise`
      // below). composeImplVerifyFixesPrompt embeds (a) originalImplSummary
      // verbatim from the closure, (b) the prior round's verdict text
      // (capped), (c) currentFixSummary.
      return composeImplVerifyFixesPrompt({
        milestoneId: milestone.id,
        cwd: ctx.cwd,
        originalImplSummary,
        priorVerdictText: prior.verdictText,
        currentFixSummary: payload,
        transcriptHints: { priorVerdictName: lastReviewerTranscriptName ?? `developer-revision-impl-${milestoneSlugForTranscripts}` },
        tddMode: ctx.tddMode,
        gitMode: ctx.gitMode,
      });
    },
    `${milestone.id} reviewer failed`,
    ctx.reviewerCardId,
    ctx.widgetOpts,
    ctx.cwd,
  );
  let round = 0;
  const reviewerFn: typeof innerReviewer = async (payload, prior, signal) => {
    round += 1;
    const result = await innerReviewer(payload, prior, signal);
    const transcriptLabel = `review-impl-${sanitizeMilestoneId(milestone.id)}`;
    await ctx.transcript.record({
      role: "reviewer",
      label: transcriptLabel,
      round,
      body: result.verdictText,
      status: result.verdict.verdict,
      meta: {
        milestoneId: milestone.id,
        P0: result.verdict.findings.P0.length,
        P1: result.verdict.findings.P1.length,
        P2: result.verdict.findings.P2.length,
        P3: result.verdict.findings.P3.length,
      },
    });
    // Best-effort transcript-name hint for the NEXT round's prompt
    // truncation marker. The transcript layer numbers files itself; we
    // don't know the exact NNNN prefix, so pass the label-based suffix
    // and let the reviewer prompt embed that as a hint.
    lastReviewerTranscriptName = `${transcriptLabel}-round-${round}-${result.verdict.verdict}`;
    return result;
  };
  const revise = async (
    findings: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
    prevPayload: string,
  ) => {
    // The DEVELOPER's revise prompt still embeds the actual prior diff —
    // user explicitly kept the developer prompts unchanged. We re-read it
    // from git here (the staged diff at this moment IS the prior cumulative
    // state, before the new revision lands).
    const actualPriorDiff = readReviewDiff(ctx.cwd, ctx.diffBaseRef);
    const revisionFinalText = await ctx.sp.spawnText(
      ctx.developer,
      {
        task: composeMilestoneRevise(milestone.id, actualPriorDiff, findings, { cwd: ctx.cwd, tddMode: ctx.tddMode, gitMode: ctx.gitMode }),
        cwd: ctx.cwd,
        signal: ctx.signal,
      },
      `developer revise failed for ${milestone.id}`,
      ctx.devCardId,
      ctx.widgetOpts,
    );
    const refreshedDiff = readReviewDiff(ctx.cwd, ctx.diffBaseRef);
    const refreshedDiffStat = readReviewDiffStat(ctx.cwd, ctx.diffBaseRef);
    // Record the revision's NARRATIVE (developer's finalText) into its own
    // transcript so the summary's truncation marker has somewhere to point.
    // Label distinguishes from `revision-impl` which holds the full diff.
    const revisionOutputLabel = `revision-output-${sanitizeMilestoneId(milestone.id)}`;
    await ctx.transcript.record({
      role: "developer",
      label: revisionOutputLabel,
      round,
      body: revisionFinalText,
      meta: { milestoneId: milestone.id, length: revisionFinalText.length },
    });
    // Transcript also gets the FULL revised diff body (separate file).
    await ctx.transcript.record({
      role: "developer",
      label: `revision-impl-${sanitizeMilestoneId(milestone.id)}`,
      round,
      body: refreshedDiff.length > 0 ? refreshedDiff : actualPriorDiff,
      meta: { milestoneId: milestone.id, length: refreshedDiff.length, fromGitDiff: refreshedDiff.length > 0 ? "yes" : "no" },
    });
    // The reviewer payload is the SUMMARY: revision narrative + cumulative
    // stat + a 12-char fingerprint of the diff body for tamper-evident
    // byte-equal-detection. Label is honest about the cumulative nature
    // (`git diff --cached --stat` reports the full staged state, not a
    // delta).
    const currentFixSummary = composeImplSummary({
      finalText: revisionFinalText,
      diffStat: refreshedDiffStat,
      diffBody: refreshedDiff.length > 0 ? refreshedDiff : actualPriorDiff,
      label: `Current cumulative file changes (includes prior round's work + this round's fix)`,
      transcriptHints: { implOutputName: revisionOutputLabel, implDiffName: `developer-revision-impl-${milestoneSlugForTranscripts}` },
    });
    // If the developer's summary AND diff fingerprint are byte-equal to
    // the prior round's, the runReviewLoop byte-equal safeguard fires.
    // The fingerprint defends against the false-positive where a refactor
    // changes content but keeps the same files/lines — those produce a
    // different fingerprint, so the safeguard correctly does NOT fire.
    void prevPayload;
    return currentFixSummary;
  };
  const review = await runLoopWithPartialOutput(
    ctx.runLoop,
    {
      initialPayload: originalImplSummary,
      reviewer: reviewerFn,
      revise,
      maxRounds: ctx.maxRounds,
      signal: ctx.signal,
    },
    ctx.partialOutputCtx,
  );

  // Configured after-verification hook with fix-loop. Defaults run here
  // after developer+reviewer convergence, but timing=off/before no-ops
  // this hook. On gate failure the helper synthesizes a P0 finding from
  // the typed VerificationGateFailure and routes it through the same
  // dev/reviewer pair (`revise` / `reviewerFn`) for the remaining
  // budget, then re-runs the gate. `phase: "before"` gates retain
  // their direct-throw behavior. Round budget is shared with the
  // impl-review loop above (the inner `runReviewer` callback maps onto
  // `reviewerFn` which increments `round` per call).
  await runVerificationGateWithFixLoop({
    gate: {
      toolName: "sf_team_implement",
      cwd: ctx.cwd,
      phase: "after",
      verification: ctx.verification,
      legacyVerifyCommand: ctx.verifyCommand,
      reporter: ctx.reporter,
      checkpoints: ctx.checkpoints,
      cache: ctx.verificationCache,
      persistentCachePath: ctx.verificationCachePath,
      agent: ctx.verificationAgent,
    },
    lastApprovedPayload: review.finalPayload,
    remainingRounds: ctx.maxRounds - round,
    callbacks: {
      runDeveloperRevise: async ({ findings, priorPayload }) =>
        revise(findings, priorPayload),
      runReviewer: async ({ payload, prior }) =>
        reviewerFn(
          payload,
          {
            findings: prior.verdict,
            verdictText: prior.verdictText,
            payload: prior.priorPayload,
          },
          ctx.signal,
        ),
      transcript: ctx.transcript,
      reporter: ctx.reporter,
    },
  });

  // Commit (per-milestone). Skip in no-git mode.
  if ((ctx.gitMode ?? "on") !== "off") {
    const sha = commitStaged(ctx.cwd, ctx.commitMessage, { allowEmpty: ctx.allowEmptyCommit });
    if (!sha) {
      throw new WorkflowStateError({
        toolName: ctx.toolName,
        description: `git commit failed for ${milestone.id}`,
        resumeHint: `invoke ${ctx.resumeTool} { resume: '${ctx.slug}' } after fixing the worktree state`,
        details: { milestoneId: milestone.id, slug: ctx.slug, worktreePath: ctx.cwd },
      });
    }
    return { id: milestone.id, approved: true, rounds: review.roundsUsed, commitSha: sha };
  }
  return { id: milestone.id, approved: true, rounds: review.roundsUsed, commitSha: undefined };
}

interface RunParallelScheduleCtx {
  repoRoot: string;
  slug: string;
  planRoot?: string;
  /** Pi tool name fronting the run, used by typed errors (e.g. EmptyDiffError, MergeFailedError). */
  toolName: string;
  /** `_resume` tool to suggest in `RESUME:` hints. */
  resumeTool: string;
  /** Empty-diff retry budget (M3). */
  emptyDiffRetries: number;
  /** Optional last-retry model bump (M3). */
  emptyDiffRetryModel?: string;
  /**
   * M4: when true, skip the post-merge `tryDeleteBranch` call and leave
   * lane branches in place. Default false (auto-delete after successful
   * merge + worktree removal).
   */
  keepLaneBranches: boolean;
  aggregateCwd: string;
  aggregateBranch: string;
  developer: TeamMember;
  reviewer: TeamMember;
  maxRounds: number;
  milestonePlan: string;
  sp: ReturnType<typeof makeSpawnHelper>;
  runLoop: ReturnType<typeof makeRunStringReviewLoop>;
  verifyCommand: SfTeamImplementInput["verifyCommand"];
  verification?: SfTeamVerificationConfigInput;
  signal?: AbortSignal;
  transcript: import("../orchestrator/run").OrchestratorBodyContext["transcript"];
  clearAgents?: () => void;
  reporter?: WorkflowReporter;
  checkpoints?: WorkflowCheckpointRuntime;
  verificationCache?: import("@pi-stef/agent-workflows").VerificationRunCache;
  verificationCachePath?: string;
  verificationAgent?: {
    member: TeamMember;
    spawnAgent: (member: TeamMember, task: import("../runtime/types").AgentTask) => Promise<import("../runtime/types").AgentRun>;
  };
  steering?: import("../orchestrator/run").OrchestratorBodyContext["steering"];
  pauseBetweenMilestones: boolean;
  shouldContinue?: SfTeamImplementInput["shouldContinue"];
  ui?: import("@earendil-works/pi-coding-agent").ExtensionUIContext;
  resumeMode: boolean;
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
}

async function runParallelSchedule(
  schedule: ExecutionSchedule,
  ctx: RunParallelScheduleCtx,
): Promise<{ outcomes: MilestoneOutcome[]; warnings: BranchCleanupWarning[] }> {
  if (!schedule.enabled) return { outcomes: [], warnings: [] };
  const outcomes: MilestoneOutcome[] = [];
  // M4: collect branch-cleanup warnings from milestone AND story lanes so
  // they all surface on SfTeamImplementResult.warnings. Story-lane warnings
  // are gathered inside `runParallelMilestoneLane` and merged here.
  const warnings: BranchCleanupWarning[] = [];
  for (let batchIndex = 0; batchIndex < schedule.milestoneBatches.length; batchIndex += 1) {
    const batch = schedule.milestoneBatches[batchIndex];
    ctx.clearAgents?.();
    const batchBaseRef = revParseCommit(ctx.aggregateCwd, "HEAD");
    const settledLaneResults = await Promise.allSettled(
      batch.milestones.map((lane) => runParallelMilestoneLane(lane, batch, batchBaseRef, ctx)),
    );
    const rejectedLane = settledLaneResults.find((result) => result.status === "rejected");
    if (rejectedLane?.status === "rejected") {
      throw rejectedLane.reason;
    }
    const laneResults = settledLaneResults.map((result) => (result as PromiseFulfilledResult<ParallelMilestoneLaneResult>).value);
    for (const laneResult of laneResults) {
      const merge = await mergeStoryWorktreeResult({
        steering: ctx.steering,
        merge: {
          targetCwd: ctx.aggregateCwd,
          sourceBranch: laneResult.branch,
          message: `merge ${laneResult.milestone.id} into ${ctx.aggregateBranch}`,
        },
      });
      if (merge.status !== "merged") {
        throw new MergeFailedError({
          toolName: ctx.toolName,
          lane: laneResult.milestone.id,
          branch: laneResult.branch,
          mergeTarget: ctx.aggregateBranch,
          status: merge.status,
          stderr: merge.stderr.trim(),
          stdout: merge.stdout.trim(),
          resumeTool: ctx.resumeTool,
          slug: ctx.slug,
        });
      }
      outcomes.push(laneResult.outcome);
      // Gather any story-lane warnings recorded inside this milestone's lane
      // run so they propagate to the top-level result.
      if (laneResult.warnings.length > 0) warnings.push(...laneResult.warnings);
      await markMilestoneCompleted(ctx.repoRoot, ctx.slug, laneResult.milestone, laneResult.outcome.commitSha, ctx.planRoot).catch(
        () => undefined,
      );
      await ctx.steering?.store
        .expireGuidanceForScope("milestone", laneResult.milestone.id)
        .catch(() => undefined);
      const removed = await removeRolledUpWorktree({
        repoRoot: ctx.repoRoot,
        worktreePath: laneResult.worktreePath,
        targetCwd: ctx.aggregateCwd,
        expectedHead: laneResult.outcome.commitSha,
      }).catch(() => false);
      if (!removed) {
        console.warn(`[sf-team] milestone lane worktree retained after rollup: ${laneResult.worktreePath}`);
      }
      // M4 milestone-lane branch cleanup. mergeTarget=aggregateBranch (the
      // branch the milestone lane just merged INTO). expectedSha is the
      // outcome.commitSha captured at lane-completion time. When
      // `parallel.keep_lane_branches=true`, the cleanup call is skipped
      // entirely — opt-in retention is not a delete failure, so it does
      // NOT push a warning (criterion 11 vs 12 distinction).
      if (!ctx.keepLaneBranches && laneResult.outcome.commitSha) {
        const result = tryDeleteBranch({
          branchName: laneResult.branch,
          repoRoot: ctx.repoRoot,
          expectedSha: laneResult.outcome.commitSha,
          mergeTarget: ctx.aggregateBranch,
        });
        if ("kind" in result) warnings.push(result);
      }
    }

    const hasMoreBatches = batchIndex < schedule.milestoneBatches.length - 1;
    if (hasMoreBatches) {
      const approvedIds = laneResults.map((result) => result.milestone.id).join(", ");
      const cont = await shouldContinueAfterParallelBatch(approvedIds, ctx);
      if (!cont) break;
    }
  }
  return { outcomes, warnings };
}

async function mergeStoryWorktreeResult(ctx: {
  steering?: import("../orchestrator/run").OrchestratorBodyContext["steering"];
  merge: Parameters<typeof mergeBranchIntoWorktree>[0];
}): Promise<ReturnType<typeof mergeBranchIntoWorktree>> {
  await ctx.steering?.drain("before-worktree-merge");
  return mergeBranchIntoWorktree(ctx.merge);
}

interface ParallelMilestoneLaneResult {
  milestone: ParsedMilestone;
  branch: string;
  worktreePath: string;
  outcome: MilestoneOutcome;
  /** Story-lane branch-cleanup warnings collected inside this milestone lane (M4). */
  warnings: BranchCleanupWarning[];
}

async function runParallelMilestoneLane(
  lane: ScheduledMilestoneLane,
  batch: ScheduledMilestoneBatch,
  baseRef: string,
  ctx: RunParallelScheduleCtx,
): Promise<ParallelMilestoneLaneResult> {
  const milestone = lane.milestone;
  const branch = `${laneBranchNamespace(ctx.aggregateBranch)}/milestones/${milestone.id}`;
  const created = await ensureLaneWorktree({
    repoRoot: ctx.repoRoot,
    slug: laneWorktreeSlug(ctx.slug, milestone.id),
    branchName: branch,
    baseRef,
    allowDirty: true,
    allowDirtyAttached: ctx.resumeMode,
    reporter: ctx.reporter,
  });
  // M4: collect story-lane branch-cleanup warnings here and surface them
  // to the parent runParallelSchedule so they end up on
  // SfTeamImplementResult.warnings.
  const warnings: BranchCleanupWarning[] = [];
  for (const storyBatch of lane.storyBatches) {
    const storyBaseRef = revParseCommit(created.worktreePath, "HEAD");
    const settledStoryResults = await Promise.allSettled(
      storyBatch.stories.map((storyLane) => runStoryLane(storyLane, milestone, storyBaseRef, branch, ctx)),
    );
    const rejectedStory = settledStoryResults.find((result) => result.status === "rejected");
    if (rejectedStory?.status === "rejected") {
      throw rejectedStory.reason;
    }
    const storyResults = settledStoryResults.map((result) => (result as PromiseFulfilledResult<StoryLaneResult>).value);
    for (const storyResult of storyResults) {
      const merge = await mergeStoryWorktreeResult({
        steering: ctx.steering,
        merge: {
          targetCwd: created.worktreePath,
          sourceBranch: storyResult.branch,
          message: `merge ${storyResult.story.id} into ${milestone.id}`,
        },
      });
      if (merge.status !== "merged") {
        throw new MergeFailedError({
          toolName: ctx.toolName,
          lane: `${milestone.id}/${storyResult.story.id}`,
          branch: storyResult.branch,
          mergeTarget: branch,
          status: merge.status,
          stderr: merge.stderr.trim(),
          stdout: merge.stdout.trim(),
          resumeTool: ctx.resumeTool,
          slug: ctx.slug,
        });
      }
      const removed = await removeRolledUpWorktree({
        repoRoot: ctx.repoRoot,
        worktreePath: storyResult.worktreePath,
        targetCwd: created.worktreePath,
        expectedHead: storyResult.commitSha,
      }).catch(() => false);
      if (!removed) {
        console.warn(`[sf-team] story lane worktree retained after rollup: ${storyResult.worktreePath}`);
      }
      // M4 story-lane branch cleanup. mergeTarget is the MILESTONE
      // branch (NOT aggregateBranch) — story lanes merge into the
      // milestone first; the milestone later merges into aggregate. R4
      // P2: passing aggregateBranch here would fail the ancestor guard
      // and leave story branches behind. When
      // `parallel.keep_lane_branches=true`, skip cleanup entirely
      // without appending a warning (opt-in retention is not a failure).
      if (!ctx.keepLaneBranches) {
        const result = tryDeleteBranch({
          branchName: storyResult.branch,
          repoRoot: ctx.repoRoot,
          expectedSha: storyResult.commitSha,
          mergeTarget: branch,
        });
        if ("kind" in result) warnings.push(result);
      }
    }
  }

  const milestoneSlug = sanitizeMilestoneId(milestone.id);
  const widgetOpts = {
    milestoneId: milestone.id,
    paneGroupId: milestone.id,
    paneLayoutRole: "reviewer" as const,
  };
  const outcome = await reviewMilestoneChanges(milestone, {
    cwd: created.worktreePath,
    toolName: ctx.toolName,
    resumeTool: ctx.resumeTool,
    slug: ctx.slug,
    emptyDiffRetries: ctx.emptyDiffRetries,
    emptyDiffRetryModel: ctx.emptyDiffRetryModel,
    developer: ctx.developer,
    reviewer: ctx.reviewer,
    maxRounds: ctx.maxRounds,
    milestonePlan: ctx.milestonePlan,
    sp: ctx.sp,
    runLoop: ctx.runLoop,
    verifyCommand: ctx.verifyCommand,
    signal: ctx.signal,
    partialOutputCtx: { repoRoot: ctx.repoRoot, slug: ctx.slug, subfolder: milestone.id },
    transcript: ctx.transcript,
    developerOutput: composeParallelMilestoneSummary(milestone, lane, batch),
    devCardId: `developer-${milestoneSlug}-revision`,
    reviewerCardId: `reviewer-${milestoneSlug}`,
    widgetOpts,
    diffLabel: `Combined committed changes for milestone ${milestone.id}`,
    commitMessage: `feat(${milestone.id}): ${milestone.title}`,
    diffBaseRef: baseRef,
    allowEmptyCommit: true,
    reporter: ctx.reporter,
    checkpoints: ctx.checkpoints,
    verification: ctx.verification,
    verificationCache: ctx.verificationCache,
    verificationCachePath: ctx.verificationCachePath,
    verificationAgent: ctx.verificationAgent,
  });
  return { milestone, branch, worktreePath: created.worktreePath, outcome, warnings };
}

interface StoryLaneResult {
  story: ParsedStory;
  branch: string;
  worktreePath: string;
  commitSha: string;
}

async function runStoryLane(
  lane: ScheduledStoryLane,
  milestone: ParsedMilestone,
  baseRef: string,
  milestoneBranch: string,
  ctx: RunParallelScheduleCtx,
): Promise<StoryLaneResult> {
  const story = lane.story;
  const branch = `${laneBranchNamespace(milestoneBranch)}/stories/${story.id}`;
  const created = await ensureLaneWorktree({
    repoRoot: ctx.repoRoot,
    slug: laneWorktreeSlug(ctx.slug, milestone.id, story.id),
    branchName: branch,
    baseRef,
    allowDirty: true,
    allowDirtyAttached: ctx.resumeMode,
    reporter: ctx.reporter,
  });
  const widgetOpts = {
    milestoneId: milestone.id,
    storyId: story.id,
    paneGroupId: milestone.id,
    paneLayoutRole: "story" as const,
    expectedWriteScope: lane.writeSet,
  };
  const cardId = `developer-${sanitizeMilestoneId(milestone.id)}-${sanitizeMilestoneId(story.id)}`;
  await runConfiguredVerification({
    toolName: "sf_team_implement",
    cwd: created.worktreePath,
    phase: "before",
    verification: ctx.verification,
    legacyVerifyCommand: ctx.verifyCommand,
    reporter: ctx.reporter,
    checkpoints: ctx.checkpoints,
    cache: ctx.verificationCache,
    persistentCachePath: ctx.verificationCachePath,
    agent: ctx.verificationAgent,
  });
  const output = await ctx.sp.spawnText(
    ctx.developer,
    {
      task: composeStoryBrief(milestone, story, lane.writeSet, ctx.milestonePlan, { cwd: created.worktreePath, tddMode: ctx.tddMode, gitMode: ctx.gitMode }),
      cwd: created.worktreePath,
      signal: ctx.signal,
    },
    `developer story impl failed for ${milestone.id}/${story.id}`,
    cardId,
    widgetOpts,
  );
  await ctx.transcript.record({
    role: "developer",
    label: `impl-output-${sanitizeMilestoneId(milestone.id)}-${sanitizeMilestoneId(story.id)}`,
    body: output,
    meta: { milestoneId: milestone.id, storyId: story.id, length: output.length },
  });
  let diff = readStagedDiff(created.worktreePath);
  // M3 S-M34: parallel-story counterpart of the milestone-level retry.
  // Uses the same `emptyDiffRetries` budget + opt-in `emptyDiffRetryModel`
  // bump. Each retry's developer output is recorded to the transcript.
  if (diff.trim().length === 0) {
    const retries = Math.max(0, ctx.emptyDiffRetries);
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const isLast = attempt === retries;
      const modelOverride = isLast ? ctx.emptyDiffRetryModel : undefined;
      await redoStoryDeveloperWithReprompt({
        milestone,
        story,
        writeSet: lane.writeSet,
        milestonePlan: ctx.milestonePlan,
        cwd: created.worktreePath,
        signal: ctx.signal,
        developer: ctx.developer,
        modelOverride,
        attemptIdx: attempt,
        cardIdBase: cardId,
        widgetOpts,
        sp: ctx.sp,
        transcript: ctx.transcript,
        tddMode: ctx.tddMode,
        gitMode: ctx.gitMode,
      });
      diff = readStagedDiff(created.worktreePath);
      if (diff.trim().length > 0) break;
    }
    if (diff.trim().length === 0) {
      const totalAttempts = 1 + retries;
      const emptyDiffDetails = {
        milestoneId: milestone.id,
        storyId: story.id,
        attempts: totalAttempts,
        slug: ctx.slug,
        worktreePath: created.worktreePath,
        resumeTool: ctx.resumeTool,
      };
      await ctx.transcript.record({
        role: "system",
        label: `empty-diff-${sanitizeMilestoneId(milestone.id)}-${sanitizeMilestoneId(story.id)}`,
        body: JSON.stringify(emptyDiffDetails, null, 2),
        meta: { milestoneId: milestone.id, storyId: story.id, kind: "empty_diff", attempts: totalAttempts },
      });
      throw new EmptyDiffError({
        toolName: ctx.toolName,
        milestoneId: milestone.id,
        storyId: story.id,
        attempts: totalAttempts,
        slug: ctx.slug,
        worktreePath: created.worktreePath,
        resumeTool: ctx.resumeTool,
      });
    }
  }
  await ctx.transcript.record({
    role: "developer",
    label: `impl-diff-${sanitizeMilestoneId(milestone.id)}-${sanitizeMilestoneId(story.id)}`,
    body: diff,
    meta: { milestoneId: milestone.id, storyId: story.id, length: diff.length },
  });
  const sha = commitStaged(created.worktreePath, `feat(${story.id}): ${commitTitle(story.description)}`);
  if (!sha) {
    throw new WorkflowStateError({
      toolName: ctx.toolName,
      description: `git commit failed for ${milestone.id}/${story.id}`,
      resumeHint: `invoke ${ctx.resumeTool} { resume: '${ctx.slug}' } after fixing the worktree state`,
      details: { milestoneId: milestone.id, storyId: story.id, slug: ctx.slug, worktreePath: created.worktreePath },
    });
  }
  return { story, branch, worktreePath: created.worktreePath, commitSha: sha };
}

async function shouldContinueAfterParallelBatch(
  approvedIds: string,
  ctx: RunParallelScheduleCtx,
): Promise<boolean> {
  if (ctx.shouldContinue) return ctx.shouldContinue(approvedIds);
  if (!ctx.pauseBetweenMilestones) return true;
  if (ctx.ui?.confirm) {
    return ctx.ui.confirm(
      "Continue to next milestone wave?",
      `Milestone(s) ${approvedIds} approved and merged. Proceed?`,
    );
  }
  console.warn("[sf-team] pause_between_milestones=true but no UI; continuing without prompt");
  return true;
}

function composeParallelMilestoneSummary(
  milestone: ParsedMilestone,
  lane: ScheduledMilestoneLane,
  batch: ScheduledMilestoneBatch,
): string {
  const storyIds = lane.storyBatches.flatMap((storyBatch) => storyBatch.stories.map((storyLane) => storyLane.story.id));
  return [
    `Milestone ${milestone.id} ran through execution strategy wave ${batch.waveId}.`,
    `Story lanes completed and merged into the milestone branch: ${storyIds.join(", ") || "none"}.`,
    "Run the combined milestone review against the branch diff from the milestone base to HEAD.",
  ].join("\n");
}

function strategyHasParallelWork(strategy: import("../plan/execution-strategy").ResolvedExecutionStrategy): boolean {
  if (strategy.maxParallelMilestones > 1 || strategy.maxParallelStoriesPerMilestone > 1) return true;
  if (strategy.milestoneWaves.some((wave) => wave.maxParallel > 1 || wave.milestones.length > 1)) return true;
  return Object.values(strategy.stories).some((storyStrategy) =>
    storyStrategy.maxParallelStories > 1
    || storyStrategy.storyWaves.some((wave) => wave.maxParallel > 1 || wave.stories.length > 1),
  );
}

/** Trim milestone id (e.g. "M0", "M3") to a transcript-safe label suffix. */
function sanitizeMilestoneId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]+/g, "");
}

interface DeveloperPromptOptions {
  cwd?: string;
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
}

function gitChangeInstructions(gitMode?: "on" | "off"): string {
  return composeDeveloperSystemPreamble({ gitMode });
}

function developerToolGuardrails(opts: DeveloperPromptOptions = {}): string {
  const cwdLine = opts.cwd
    ? `Current working directory: ${opts.cwd} (repo/worktree root).`
    : "Current working directory is the repo/worktree root.";
  return [
    "Tool-use guardrails:",
    cwdLine,
    "- Prefer `rg` and `rg --files` for repo inspection.",
    "- Do not search above `.`; stay inside the current repo/worktree root.",
    "- Do not run recursive `find` or broad searches under `/Users`, `$HOME`, `/`, or parent directories.",
    "- Keep shell commands bounded. If a command produces no useful output quickly, stop and use a narrower repo-scoped command.",
    "- Before review, run only lightweight targeted checks needed for confidence. Leave any configured full-suite/typecheck/e2e verification to the orchestrator after impl-review approval.",
  ].join("\n");
}

/**
 * M3 S-M32: re-invoke the developer agent with an explicit reprompt that
 * names the milestone and demands actual staged changes. Records the
 * retry's developer output to the transcript under
 * `developer-impl-retry-${milestoneId}-${attemptIdx}`. When
 * `modelOverride` is supplied, swaps the developer's model for THIS run
 * only (the rest of the team config is unchanged) — used for the
 * opt-in last-retry model bump.
 */
async function redoDeveloperWithReprompt(
  milestone: ParsedMilestone,
  ctx: ReviewMilestoneChangesCtx,
  attemptIdx: number,
  modelOverride: string | undefined,
): Promise<string> {
  const developer: TeamMember = modelOverride
    ? { ...ctx.developer, model: modelOverride }
    : ctx.developer;
  const reprompt = composeEmptyDiffReprompt(milestone, ctx.cwd, attemptIdx, { tddMode: ctx.tddMode, gitMode: ctx.gitMode });
  const widgetAgentId = `${ctx.devCardId}-retry-${attemptIdx}`;
  const newOutput = await ctx.sp.spawnText(
    developer,
    {
      task: reprompt,
      cwd: ctx.cwd,
      signal: ctx.signal,
    },
    `developer impl retry-${attemptIdx} failed for ${milestone.id}`,
    widgetAgentId,
    ctx.widgetOpts,
  );
  await ctx.transcript.record({
    role: "developer",
    label: `developer-impl-retry-${sanitizeMilestoneId(milestone.id)}-${attemptIdx}`,
    body: newOutput,
    meta: {
      milestoneId: milestone.id,
      attempt: attemptIdx,
      modelOverride: modelOverride ?? "(none)",
      effectiveModel: developer.model,
    },
  });
  return newOutput;
}

/**
 * S-M32: parallel-story counterpart of `redoDeveloperWithReprompt`.
 * The story site doesn't have a ReviewMilestoneChangesCtx, so it
 * passes the few fields it needs directly. Records the retry under
 * `developer-impl-retry-${milestoneId}-${storyId}-${attemptIdx}`.
 */
async function redoStoryDeveloperWithReprompt(opts: {
  milestone: ParsedMilestone;
  story: ParsedStory;
  writeSet: ScheduledStoryLane["writeSet"];
  milestonePlan: string;
  cwd: string;
  signal?: AbortSignal;
  developer: TeamMember;
  modelOverride?: string;
  attemptIdx: number;
  cardIdBase: string;
  widgetOpts: { milestoneId?: string; storyId?: string; paneGroupId?: string; paneLayoutRole?: import("../tmux/manager").PaneLayoutRole };
  sp: ReturnType<typeof makeSpawnHelper>;
  transcript: import("../orchestrator/run").OrchestratorBodyContext["transcript"];
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
}): Promise<string> {
  const developer: TeamMember = opts.modelOverride
    ? { ...opts.developer, model: opts.modelOverride }
    : opts.developer;
  const reprompt = composeStoryEmptyDiffReprompt(opts.milestone, opts.story, opts.writeSet, opts.milestonePlan, opts.cwd, opts.attemptIdx, { tddMode: opts.tddMode, gitMode: opts.gitMode });
  const widgetAgentId = `${opts.cardIdBase}-retry-${opts.attemptIdx}`;
  const newOutput = await opts.sp.spawnText(
    developer,
    { task: reprompt, cwd: opts.cwd, signal: opts.signal },
    `developer story-impl retry-${opts.attemptIdx} failed for ${opts.milestone.id}/${opts.story.id}`,
    widgetAgentId,
    opts.widgetOpts,
  );
  await opts.transcript.record({
    role: "developer",
    label: `developer-impl-retry-${sanitizeMilestoneId(opts.milestone.id)}-${sanitizeMilestoneId(opts.story.id)}-${opts.attemptIdx}`,
    body: newOutput,
    meta: {
      milestoneId: opts.milestone.id,
      storyId: opts.story.id,
      attempt: opts.attemptIdx,
      modelOverride: opts.modelOverride ?? "(none)",
      effectiveModel: developer.model,
    },
  });
  return newOutput;
}

/**
 * Build the milestone-level empty-diff reprompt body. The agent is told
 * unambiguously that its previous attempt staged no changes and that it
 * MUST use Edit/Write to stage actual changes this time. The expected
 * stories list keeps the agent grounded in the milestone scope.
 */
export function composeEmptyDiffReprompt(milestone: ParsedMilestone, cwd: string, attemptIdx: number, opts: DeveloperPromptOptions = {}): string {
  const stories = milestone.stories
    .filter((s) => s.status !== "completed")
    .map((s) => `- ${s.id}: ${s.description}`)
    .join("\n");
  return [
    opts.gitMode === "off"
      ? `Retry ${attemptIdx}: your previous impl attempt for milestone ${milestone.id} produced no file changes.`
      : `Retry ${attemptIdx}: your previous impl attempt for milestone ${milestone.id} produced an empty git diff.`,
    "",
    opts.gitMode === "off"
      ? "Your previous attempt produced no file changes. Use the Edit/Write tools to make actual changes — DO NOT respond with a plan or summary."
      : "Your previous attempt produced no diff. Use the Edit/Write tools to stage actual changes — DO NOT respond with a plan or summary.",
    "",
    "Stories to complete:",
    stories,
    "",
    "Required actions:",
    "- Read the relevant files with the Read/Grep tools.",
    "- Make the code changes via Edit / Write tools (NOT shell echo or sed).",
    opts.gitMode === "off"
      ? "- Do NOT use git commands."
      : "- Stage only the files you touched (never git add -A).",
    opts.gitMode !== "off"
      ? "- Do NOT run `git commit` — the orchestrator commits after impl-review approves your staged diff."
      : "",
    composeTddContract({ tddMode: opts.tddMode, gitMode: opts.gitMode }),
    "",
    developerToolGuardrails({ cwd }),
  ].filter(Boolean).join("\n");
}

/** Story-level empty-diff reprompt body. */
export function composeStoryEmptyDiffReprompt(
  milestone: ParsedMilestone,
  story: ParsedStory,
  writeSet: ScheduledStoryLane["writeSet"],
  milestonePlan: string,
  cwd: string,
  attemptIdx: number,
  opts: DeveloperPromptOptions = {},
): string {
  const expectedFiles = (writeSet ?? []).map((f) => `- ${f}`).join("\n");
  return [
    opts.gitMode === "off"
      ? `Retry ${attemptIdx}: your previous impl attempt for ${milestone.id}/${story.id} produced no file changes.`
      : `Retry ${attemptIdx}: your previous impl attempt for ${milestone.id}/${story.id} produced an empty git diff.`,
    "",
    opts.gitMode === "off"
      ? "Your previous attempt produced no file changes. Use the Edit/Write tools to make actual changes — DO NOT respond with a plan or summary."
      : "Your previous attempt produced no diff. Use the Edit/Write tools to stage actual changes — DO NOT respond with a plan or summary.",
    "",
    `Story: ${story.id} — ${story.description}`,
    expectedFiles
      ? ["", "Expected file write set:", expectedFiles].join("\n")
      : "",
    "",
    "Required actions:",
    "- Read the relevant files with the Read/Grep tools.",
    "- Make the code changes via Edit / Write tools (NOT shell echo or sed).",
    opts.gitMode === "off"
      ? "- Do NOT use git commands."
      : "- Stage only files you touched (never git add -A).",
    opts.gitMode !== "off"
      ? "- Do NOT run `git commit` — the orchestrator commits after impl-review approves your staged diff."
      : "",
    composeTddContract({ tddMode: opts.tddMode, gitMode: opts.gitMode }),
    "",
    developerToolGuardrails({ cwd }),
    "",
    `## Milestone reference (${milestone.id})`,
    extractMilestoneSection(milestonePlan, milestone.id) ?? "",
  ].filter(Boolean).join("\n");
}

export function composeMilestoneBrief(
  m: ParsedMilestone,
  milestonePlan: string,
  opts: DeveloperPromptOptions = {},
): string {
  const stories = m.stories
    .filter((s) => s.status !== "completed")
    .map((s) => `- ${s.id}: ${s.description}`)
    .join("\n");
  // Slice out just the M<id> section. Inlining the whole plan (M1+M2+...+Mn)
  // can balloon to hundreds of KB on even moderately-sized plans and pushes
  // the developer's first tool call past the heartbeat threshold while the
  // model is still reading the input.
  const section = extractMilestoneSection(milestonePlan, m.id) ?? milestonePlan;
  return [
    `Implement milestone ${m.id}: ${m.title}`,
    "",
    "Stories to complete:",
    stories,
    "",
    gitChangeInstructions(opts.gitMode),
    composeTddContract({ tddMode: opts.tddMode, gitMode: opts.gitMode }),
    developerToolGuardrails(opts),
    "",
    `## Milestone-plan reference (${m.id} only)`,
    section,
  ].join("\n");
}

export function composeStoryBrief(
  milestone: ParsedMilestone,
  story: ParsedStory,
  writeSet: string[],
  milestonePlan: string,
  opts: DeveloperPromptOptions = {},
): string {
  const section = extractMilestoneSection(milestonePlan, milestone.id) ?? milestonePlan;
  return [
    `Implement story ${story.id} for milestone ${milestone.id}: ${milestone.title}`,
    "",
    `Story: ${story.description}`,
    writeSet.length > 0 ? `Expected write set: ${writeSet.join(", ")}` : "Expected write set: not declared; keep the edit narrowly scoped to this story.",
    "",
    gitChangeInstructions(opts.gitMode),
    composeTddContract({ tddMode: opts.tddMode, gitMode: opts.gitMode }),
    developerToolGuardrails(opts),
    "",
    `## Milestone-plan reference (${milestone.id} only)`,
    section,
  ].join("\n");
}

/**
 * Slice the section for `milestoneId` out of a milestone-plan.md body.
 *
 * Heading match is permissive: 2–4 hashes, the milestone id (`M\d+`)
 * followed by a word-boundary so `M1` does not match `M10`, and an optional
 * separator (`:`, em-dash `—`, or `-`) before the title.
 *
 * Slice ends at the earliest of:
 *   (a) any heading whose level matches another milestone (`M\d+`) — this
 *       handles e.g. mixed `## M1` … `### M2` plans;
 *   (b) any non-milestone heading at the same level as the start heading or
 *       higher (i.e. fewer or equal hashes) — `### Acceptance Criteria` and
 *       `#### Stories` *within* the milestone body are explicitly kept;
 *   (c) end of input.
 *
 * Any trailing horizontal-rule lines (`---`/`***`/`___`) and blank lines are
 * stripped from the slice. Returns undefined if the start heading is missing.
 */
export function extractMilestoneSection(milestonePlan: string, milestoneId: string): string | undefined {
  const lines = milestonePlan.split("\n");
  const idEsc = escapeRegExp(milestoneId);
  const startRe = new RegExp(`^(#{2,4})\\s+${idEsc}\\b\\s*[:\\u2014\\-]?\\s*`);
  const milestoneHeadingRe = /^#{2,4}\s+M\d+\b/;
  const headingRe = /^(#{2,4})\s+\S/;
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRe);
    if (m) {
      start = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (milestoneHeadingRe.test(line)) {
      end = j;
      break;
    }
    const h = line.match(headingRe);
    if (h && h[1].length <= startLevel) {
      end = j;
      break;
    }
  }
  // Trim trailing horizontal rules and blank lines from the slice.
  while (end > start + 1) {
    const tail = lines[end - 1].trim();
    if (tail === "" || tail === "---" || tail === "***" || tail === "___") {
      end -= 1;
      continue;
    }
    break;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function composeMilestoneRevise(
  milestoneId: string,
  prevDiff: string,
  v: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
  opts: DeveloperPromptOptions = {},
): string {
  return [
    `Update milestone ${milestoneId} to address findings:`,
    "",
    formatFindings(v.findings),
    "",
    gitChangeInstructions(opts.gitMode),
    composeTddContract({ tddMode: opts.tddMode, gitMode: opts.gitMode }),
    developerToolGuardrails(opts),
    "",
    "## Prior diff",
    prevDiff,
  ].join("\n");
}

function formatFindings(f: { P0: string[]; P1: string[]; P2: string[]; P3: string[] }): string {
  const out: string[] = [];
  for (const sev of ["P0", "P1", "P2", "P3"] as const) {
    out.push(`### ${sev}`);
    if (f[sev].length === 0) out.push("- None.");
    else out.push(...f[sev].map((x) => `- ${x}`));
  }
  return out.join("\n");
}

async function markMilestoneCompleted(
  repoRoot: string,
  slug: string,
  milestone: ParsedMilestone,
  commitSha: string | undefined,
  planRoot?: string,
): Promise<void> {
  for (const story of milestone.stories) {
    if (story.status === "completed" || story.status === "deferred") continue;
    await updateStoryTracker(repoRoot, {
      slug,
      storyId: story.id,
      status: "completed",
      notes: commitSha ?? story.notes,
    }, planRoot);
  }
  await updateMilestoneApproval(repoRoot, {
    slug,
    milestoneId: milestone.id,
    approvalStatus: commitSha ? `approved (${commitSha})` : "approved",
  }, planRoot);
}

function defaultDev(agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents): TeamMember {
  const d = agents.developer;
  return {
    role: "developer",
    model: d.model,
    thinking: d.thinking,
    heartbeatMs: d.heartbeatMs,
    // Intentionally NO `finishing-a-development-branch`: that skill instructs
    // the agent to run `git commit` when work is complete, which directly
    // contradicts the orchestrator's contract (orchestrator owns the commit
    // after impl-review approves). Including it caused sf_team_implement to
    // throw "developer staged nothing" because the dev had already committed
    // its own changes inside the worktree.
    // Also no `using-git-worktrees`: the worktree is created and `cwd`-set
    // by the orchestrator before the dev spawns; the dev does not need to
    // create or manage a worktree itself.
    skills: ["tdd", "verification-before-completion"],
  };
}

function defaultReviewer(agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents): TeamMember {
  const d = agents.reviewer;
  return { role: "reviewer", model: d.model, thinking: d.thinking, heartbeatMs: d.heartbeatMs };
}

/**
 * Stage tracked-file modifications (`git add -u`) before reading the
 * developer's diff. Some model providers (notably cursor/composer-2)
 * happily run Edit/Write tool calls but skip the `git add` step the
 * developer brief asks for. Without this auto-stage, those edits look
 * identical to "did nothing" — the M3 empty-diff retry exhausts itself
 * making more unstaged edits while the worktree fills up with real
 * uncommitted work.
 *
 * `-u` only restages already-tracked paths. New untracked files are
 * NOT auto-added — the developer is still expected to `git add` those
 * explicitly. Auto-adding everything (`git add .`) would also pick up
 * stray dotfiles, build artifacts, and node_modules drift.
 *
 * Idempotent: safe to call before every diff read. Failures are
 * intentionally swallowed — if `git add -u` itself errors, the
 * subsequent `git diff` will still report whatever happens to be
 * staged, and the existing empty-diff path will surface the real
 * problem.
 */
function stageTrackedModifications(cwd: string): void {
  spawnSync("git", ["add", "-u"], { cwd, encoding: "utf8" });
}

function readStagedDiff(cwd: string): string {
  stageTrackedModifications(cwd);
  const r = spawnSync("git", ["diff", "--cached"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function readReviewDiff(cwd: string, baseRef: string | undefined): string {
  if (!baseRef) return readStagedDiff(cwd);
  stageTrackedModifications(cwd);
  const committed = spawnSync("git", ["diff", `${baseRef}..HEAD`], { cwd, encoding: "utf8" });
  const staged = spawnSync("git", ["diff", "--cached"], { cwd, encoding: "utf8" });
  return [
    committed.status === 0 ? committed.stdout : "",
    staged.status === 0 ? staged.stdout : "",
  ].filter((part) => part.trim().length > 0).join("\n");
}

/**
 * Read `git diff --cached --stat` output: the per-file change summary
 * (lines like ` feat.ts | 5 +++++` and a trailing ` N file changed, M
 * insertions(+) ...`). Used by the impl-review summary path so the
 * reviewer sees what changed at a file/line level without the full diff
 * body. Independent from {@link readStagedDiff}, which still produces
 * the full diff for transcripts.
 */
function readStagedDiffStat(cwd: string): string {
  const r = spawnSync("git", ["diff", "--cached", "--stat"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function readReviewDiffStat(cwd: string, baseRef: string | undefined): string {
  if (!baseRef) return readStagedDiffStat(cwd);
  const committed = spawnSync("git", ["diff", `${baseRef}..HEAD`, "--stat"], { cwd, encoding: "utf8" });
  const staged = spawnSync("git", ["diff", "--cached", "--stat"], { cwd, encoding: "utf8" });
  return [
    committed.status === 0 ? committed.stdout : "",
    staged.status === 0 ? staged.stdout : "",
  ].filter((part) => part.trim().length > 0).join("\n");
}

function commitStaged(cwd: string, message: string, opts: { allowEmpty?: boolean } = {}): string | undefined {
  if (!opts.allowEmpty) {
    const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd, encoding: "utf8" });
    if (staged.status === 0) return headCommitWithSubject(cwd, message);
  }
  const args = ["commit", "-q", "-m", message];
  if (opts.allowEmpty) args.splice(1, 0, "--allow-empty");
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return head.stdout.trim() || undefined;
}

function headCommitWithSubject(cwd: string, message: string): string | undefined {
  const r = spawnSync("git", ["log", "-1", "--format=%H%x00%s"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const [hash, subject] = r.stdout.split("\0");
  return subject?.trim() === message ? hash?.trim() || undefined : undefined;
}

function revParseCommit(cwd: string, ref: string): string {
  const r = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`sf_team_implement: cannot resolve git ref ${ref}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

function laneWorktreeSlug(slug: string, milestoneId: string, storyId?: string): string {
  return [slug, milestoneId, storyId]
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}

function laneBranchNamespace(aggregateBranch: string): string {
  return aggregateBranch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Map an inbound Pi tool surface name (e.g. `sf_team_implement`) to
 * the corresponding `_resume` tool name. Used by typed-error composition
 * so `RESUME:` hints point at the right resume entry point regardless of
 * whether the run was driven by `sf_team_implement` or `sf_team_auto`.
 *
 * Falls back to `sf_team_implement_resume` when `toolName` is missing or
 * unrecognized — implementing the implement-side default keeps existing
 * call sites that did not (yet) pass `toolName` working.
 */
/**
 * Resolve the empty-diff retry budget (M3 S-M31). The implement tool reads
 * `implement.empty_diff_retries` and the auto tool reads
 * `auto.empty_diff_retries` so each surface can have a distinct budget.
 * Falls back to `DEFAULT_CONFIG.implement.empty_diff_retries` (=2).
 */
function resolveEmptyDiffRetries(piToolName: string, configDefaults: ResolvedDefaults | undefined): number {
  if (piToolName.startsWith("sf_team_auto")) {
    return configDefaults?.auto.empty_diff_retries ?? DEFAULT_CONFIG.auto.empty_diff_retries;
  }
  return configDefaults?.implement.empty_diff_retries ?? DEFAULT_CONFIG.implement.empty_diff_retries;
}

/**
 * Resolve the optional last-retry model bump (M3 S-M31). Unset by default
 * — only LAST attempt uses it, and only when configured.
 */
function resolveEmptyDiffRetryModel(piToolName: string, configDefaults: ResolvedDefaults | undefined): string | undefined {
  if (piToolName.startsWith("sf_team_auto")) {
    return configDefaults?.auto.empty_diff_retry_model;
  }
  return configDefaults?.implement.empty_diff_retry_model;
}

export function resolveResumeTool(toolName: string | undefined): string {
  if (!toolName) return "sf_team_implement_resume";
  if (toolName.startsWith("sf_team_auto")) return "sf_team_auto_resume";
  if (toolName.startsWith("sf_team_implement")) return "sf_team_implement_resume";
  if (toolName.startsWith("sf_team_followup")) return "sf_team_followup_resume";
  if (toolName.startsWith("sf_team_task")) return "sf_team_task_resume";
  if (toolName.startsWith("sf_team_plan")) return "sf_team_plan_resume";
  return "sf_team_implement_resume";
}

function commitTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 72) || "story";
}

export function runVerification(
  cwd: string,
  verifyCommand: SfTeamImplementInput["verifyCommand"],
  reporter?: WorkflowReporter,
  checkpoints?: WorkflowCheckpointRuntime,
): void {
  runLegacyVerificationSync("sf_team_implement", cwd, verifyCommand, reporter, checkpoints);
}
