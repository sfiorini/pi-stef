import { spawnSync } from "node:child_process";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type ResumeAnalysis,
  type WorkflowToolName,
} from "@pi-stef/agent-workflows";

import { WorkflowStateError } from "../errors";
import { generatePrDescription } from "../orchestrator/pr-description";
import { runOrchestrator } from "../orchestrator/run";
import { writePlanFolder } from "../plan/write";
import { slugify } from "../plan/slug";
import { requireGitOrSkip } from "../worktree/validate";

import { DEFAULT_CONFIG, type ResolvedDefaults } from "../config/schema";
import {
  effectiveTmuxManager,
  effectiveUi,
  implementationReviewMaxRounds,
  planReviewMaxRounds,
  workflowProfile,
} from "../config/workflow";
import type { PlanRevisionMetrics } from "../plan/revision-metrics";

import { composeImplSummary, composeImplVerifyFixesPrompt } from "./impl-summary";
import { revisePlanWithPatchOrFallback } from "./plan-revision";
import { normalOrResumeValue, resolveToolResume } from "./resume";
import {
  composeDeveloperSystemPreamble,
  composePlanVerifyFixesPrompt,
  defaultDeps,
  makeReviewer,
  makeRunStringReviewLoop,
  makeSpawnHelper,
  PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE,
  runLoopWithPartialOutput,
  truncatePayloadBytes,
  type ToolDeps,
} from "./shared";
import {
  assertCleanWorktree,
  commitStaged,
  defaultMember,
  readStagedDiff,
  readStagedDiffStat,
} from "./shared-helpers";
import { decideSteeringInstruction, decideSteeringInstructions } from "../steering/decider";
import { enforcePauseAtSafeBoundary } from "../steering/pause-enforcement";
import type { SfTeamTaskInput, SfTeamTaskResult } from "./task-types";
import {
  PLANNER_TDD_REMINDER,
  REVIEWER_TDD_POLICY,
  composeTddContract,
} from "./tdd-policy";
import {
  runConfiguredVerification,
  type SfTeamVerificationConfigInput,
} from "./verification-stage";
import { runVerificationGateWithFixLoop } from "./verification-gate-loop";

/**
 * Subset of per-tool config that the shared task workflow consumes.
 * Each profile's `resolveConfigDefaults` adapter projects from its source
 * block in `ResolvedDefaults` (e.g. `defaults.task` or `defaults.followup`)
 * into this shape. The two `ResolvedDefaults` blocks have different fields
 * (followup never had `use_worktree` / `create_branch`), so we don't share
 * the source types directly.
 */
export interface RunTaskWorkflowDefaults {
  allow_dirty: boolean;
  use_worktree: boolean;
  create_branch: boolean;
  verification: SfTeamVerificationConfigInput;
}

/**
 * Per-tool identity captured by `runTaskWorkflow`. `task.ts` and
 * `followup.ts` each export a profile and route through the shared body.
 */
export interface RunTaskWorkflowProfile {
  /** Tool name written into workflow metadata, lock metadata, and most error prefixes. */
  toolName: WorkflowToolName;
  /** Owner tool recorded in workflow.json. Same as toolName except for nested cases. */
  ownerTool: WorkflowToolName;
  /** Resume-tool name interpolated into "use <X> to resume" hints. */
  resumeToolName: string;
  /** Adapter that projects per-tool config defaults into the shared shape. Returns undefined when the source block is absent. */
  resolveConfigDefaults: (defaults: ResolvedDefaults | undefined) => RunTaskWorkflowDefaults | undefined;
  /** AskUser key prefix; keeps task vs followup prompts distinct in transcripts. */
  askUserKeyPrefix: "task" | "followup";
  /** Error message prefix for typed errors thrown out of the workflow. */
  errorPrefix: string;
}

export interface RunTaskWorkflowOptions {
  profile: RunTaskWorkflowProfile;
  /**
   * Parent plan context — only set for followups. Threaded into the
   * planner brief AND persisted as `parentSlug` in workflow.json.
   */
  parentContext?: {
    slug: string;
    parentMilestonePlan: string;
  };
  /**
   * Pre-resolved slug overrides `slugify(title)`. Used by followup so it
   * can call `followupSlug()` (date + `followup-` + kebab) externally
   * without re-implementing slugify here.
   */
  slugOverride?: string;
  /**
   * Pre-computed resume analysis. When undefined, runTaskWorkflow calls
   * `resolveToolResume` itself.
   */
  resume?: ResumeAnalysis;
}

export interface RunTaskWorkflowCtx {
  repoRoot: string;
  signal?: AbortSignal;
  ui?: ExtensionUIContext;
  configDefaults?: ResolvedDefaults;
  toolName?: string;
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
  /** Resolved planRoot for this run; when set, passed as candidatePlanRoots to resume discovery. */
  planRoot?: string;
  /** Raw prompt value for gitMode before runtime resolution; used for resume precedence. */
  rawGitMode?: "auto" | "on" | "off";
  /** Raw prompt value for tddMode before runtime resolution; used for resume precedence. */
  rawTddMode?: "auto" | "on" | "off";
}

export async function runTaskWorkflow(
  deps: ToolDeps,
  input: SfTeamTaskInput,
  ctx: RunTaskWorkflowCtx,
  options: RunTaskWorkflowOptions,
): Promise<SfTeamTaskResult> {
  const { profile, parentContext } = options;
  const runLoop = makeRunStringReviewLoop(deps);

  const resume = options.resume
    ?? (await resolveToolResume({
      repoRoot: ctx.repoRoot,
      toolName: profile.toolName,
      input,
      normalField: "title",
      candidatePlanRoots: ctx.planRoot ? [ctx.planRoot] : undefined,
    }));
  // Resume precedence: use persisted gitMode/tddMode from workflow.json when
  // the user did not supply an explicit 'on'/'off' override (undefined or 'auto'
  // are treated as "unset" for this purpose).
  const effectiveGitMode: "on" | "off" =
    resume?.metadata?.gitMode != null && (ctx.rawGitMode === undefined || ctx.rawGitMode === "auto")
      ? resume.metadata.gitMode
      : (ctx.gitMode ?? "on");
  const effectiveTddMode: "on" | "off" | "auto" =
    resume?.metadata?.tddMode != null && (ctx.rawTddMode === undefined || ctx.rawTddMode === "auto")
      ? resume.metadata.tddMode
      : (ctx.tddMode ?? "auto");
  // effectivePlanRoot: prefer resume metadata's planRootPath (set when plan was found via
  // global index or external candidatePlanRoots) over the prompt-resolved ctx.planRoot.
  const effectivePlanRoot = resume?.metadata?.planRootPath ?? ctx.planRoot;
  // Preflight git check after effective mode resolution so a slug-only resume
  // from a non-git cwd of a no-git workflow uses the persisted gitMode='off'.
  requireGitOrSkip({ repoRoot: ctx.repoRoot, gitMode: effectiveGitMode }, profile.toolName);
  const title = normalOrResumeValue(input, "title", resume);
  const normalizedInput: SfTeamTaskInput = { ...input, title };
  const slug = resume?.target.slug ?? options.slugOverride ?? slugify(title);

  const profileDefaults = profile.resolveConfigDefaults(ctx.configDefaults);
  const agents = ctx.configDefaults?.agents ?? DEFAULT_CONFIG.agents;
  const planner = input.planner ?? defaultMember("planner", [], agents);
  const developer = input.developer ?? defaultMember("developer", ["tdd", "verification-before-completion"], agents);
  const reviewer = input.reviewer ?? defaultMember("reviewer", [], agents);
  const ui = effectiveUi(ctx.ui, ctx.configDefaults);
  const planMaxRounds = planReviewMaxRounds(input.maxRounds, ctx.configDefaults);
  const implementationMaxRounds = implementationReviewMaxRounds(input.maxRounds, ctx.configDefaults);
  const planRevisionMode = ctx.configDefaults?.performance.plan_revision ?? DEFAULT_CONFIG.performance.plan_revision;
  const revisionMetrics: PlanRevisionMetrics[] = [];
  const enrichedBrief = await maybeAskForBrief(
    normalizedInput.brief,
    { ui, signal: ctx.signal, askUserKeyPrefix: profile.askUserKeyPrefix },
  );

  const planLabel = parentContext ? "followup plan" : "single-task plan";
  const reviewSubject = parentContext ? "this followup plan" : "this single-task plan";

  const orchestrated = await runOrchestrator(
    {
      repoRoot: ctx.repoRoot,
      slug,
      planRoot: effectivePlanRoot,
      toolName: profile.toolName,
      ownerTool: profile.ownerTool,
      // Both tools edit ctx.repoRoot; `useWorktree=false` so the
      // orchestrator captures the baseline. The followup config no
      // longer carries `reuse_parent_worktree` (mirrors task).
      useWorktree: false,
      parentSlug: parentContext?.slug,
      gitMode: effectiveGitMode,
      tddMode: effectiveTddMode,
      signal: ctx.signal,
      ui,
      tmuxManager: effectiveTmuxManager(undefined, ctx.configDefaults),
      workflowProfile: workflowProfile(ctx.configDefaults),
      resumeMode: !!resume,
      reviewRoundLimits: {
        maxRounds: ctx.configDefaults?.review.max_rounds ?? DEFAULT_CONFIG.review.max_rounds,
        planMaxRounds,
        implementationMaxRounds,
      },
      widgetUpdateIntervalMs: ctx.configDefaults?.performance.widget_update_interval_ms
        ?? DEFAULT_CONFIG.performance.widget_update_interval_ms,
    },
    async (bodyCtx) => {
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
          cwd: ctx.repoRoot,
          signal: bodyCtx.signal,
        })
      );
      bodyCtx.steering.setBatchDecider((batchInput) =>
        decideSteeringInstructions(batchInput, {
          sp,
          member: { ...reviewer, role: "steering-decider", skills: [] },
          cwd: ctx.repoRoot,
          signal: bodyCtx.signal,
        })
      );
      const runSteeredSpawnText: ReturnType<typeof makeSpawnHelper>["spawnText"] = async (...args) => {
        await bodyCtx.steering.drain("before-agent-spawn");
        try {
          return await sp.spawnText(...args);
        } finally {
          await bodyCtx.steering.drain("agent-ended");
        }
      };
      const steeredSp: ReturnType<typeof makeSpawnHelper> = { ...sp, spawnText: runSteeredSpawnText };

      // Dirty-worktree guard. Resolution: prompt arg → config → default.
      // Skip in no-git mode (no git repo to check).
      const allowDirty = input.allowDirty ?? profileDefaults?.allow_dirty ?? false;
      if (effectiveGitMode !== "off" && !allowDirty) {
        assertCleanWorktree(profile.toolName, ctx.repoRoot);
      }
      await bodyCtx.steering.drain("workflow-start");
      await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });

      // Phase 1: planner draft + plan-review loop.
      const planDraft = await runSteeredSpawnText(
        planner,
        {
          task: composePlanBrief({ ...normalizedInput, brief: enrichedBrief }, parentContext, { tddMode: effectiveTddMode }),
          signal: bodyCtx.signal,
        },
        "planner draft failed",
      );
      await bodyCtx.transcript.record({
        role: "planner",
        label: "draft",
        body: planDraft,
        meta: { length: planDraft.length },
      });

      // Hold the round-1 plan body so round 2+ anchor to it (instead of
      // drifting through immediately-previous payloads).
      let originalPlan: string | undefined;
      const innerPlanReviewer = makeReviewer(
        runSteeredSpawnText,
        reviewer,
        (p, prior) => {
          if (!prior) {
            originalPlan = p;
            return [
              `Review ${reviewSubject}.`,
              "",
              PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE,
              "",
              truncatePayloadBytes(p, "planner-draft"),
            ].join("\n");
          }
          return composePlanVerifyFixesPrompt({
            label: planLabel,
            originalPlan: originalPlan ?? "",
            priorVerdictText: prior.verdictText,
            currentPlan: p,
          });
        },
        "plan reviewer failed",
        undefined,
        undefined,
        ctx.repoRoot,
      );
      let planRound = 0;
      const planReviewerFn: typeof innerPlanReviewer = async (payload, prior, signal) => {
        planRound += 1;
        const result = await innerPlanReviewer(payload, prior, signal);
        await bodyCtx.transcript.record({
          role: "reviewer",
          label: "review-plan",
          round: planRound,
          body: result.verdictText,
          status: result.verdict.verdict,
          meta: {
            P0: result.verdict.findings.P0.length,
            P1: result.verdict.findings.P1.length,
            P2: result.verdict.findings.P2.length,
            P3: result.verdict.findings.P3.length,
          },
        });
        return result;
      };
      const planRevise = async (
        findings: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
        prev: string,
      ) => {
        const result = await revisePlanWithPatchOrFallback({
          mode: planRevisionMode,
          priorPlan: prev,
          findings,
          planner,
          sp: steeredSp,
          signal: bodyCtx.signal,
          transcript: bodyCtx.transcript,
          round: planRound,
          label: planLabel,
          errorPrefix: "planner revise failed",
          composeFullPrompt: () => composePlanRevise(prev, findings, parentContext, { tddMode: effectiveTddMode }),
          extraContext: parentContext
            ? ["Parent plan context:", parentContext.parentMilestonePlan].join("\n")
            : undefined,
        });
        revisionMetrics.push(result.metrics);
        await bodyCtx.transcript.record({
          role: "planner",
          label: "revision-plan",
          round: planRound,
          body: result.plan,
          meta: {
            length: result.plan.length,
            revisionMode: result.metrics.mode,
            patchAttempted: result.metrics.patchAttempted ? "yes" : "no",
            patchApplied: result.metrics.patchApplied ? "yes" : "no",
            fallbackUsed: result.metrics.fallbackUsed ? "yes" : "no",
          },
        });
        return result.plan;
      };
      const plan = await runLoopWithPartialOutput(
        runLoop,
        {
          initialPayload: planDraft,
          reviewer: planReviewerFn,
          revise: planRevise,
          maxRounds: planMaxRounds,
          signal: bodyCtx.signal,
        },
        { repoRoot: ctx.repoRoot, slug },
      );

      // Persist task-plan.md (followup writes its own task-plan.md too —
      // no overlay-into-parent layout anymore).
      await writePlanFolder(ctx.repoRoot, {
        kind: "task",
        slug,
        files: { "task-plan.md": plan.finalPayload },
      }, effectivePlanRoot);

      await runConfiguredVerification({
        toolName: profile.toolName,
        cwd: ctx.repoRoot,
        phase: "before",
        verification: input.verification ?? profileDefaults?.verification,
        legacyVerifyCommand: input.verifyCommand,
        reporter: bodyCtx.reporter,
        checkpoints: bodyCtx.checkpoints,
        cache: bodyCtx.verificationCache,
        persistentCachePath: bodyCtx.verificationCachePath,
        agent: {
          member: reviewer,
          // Route through makeSpawnHelper so steering guidance reaches the
          // verifier-agent prompt the same way it reaches developer/planner.
          spawnAgent: (member, task) => sp.spawn(member, task, member.role),
        },
      });

      // Phase 2: developer-impl + strict staging. Switch the transcript
      // phase here so every developer/impl-reviewer entry lands under
      // transcript/implementation/ instead of planning.
      bodyCtx.transcript.setPhase("implementation");
      const implOutput = await runSteeredSpawnText(
        developer,
        { task: composeDeveloperBrief(plan.finalPayload, { tddMode: effectiveTddMode, gitMode: effectiveGitMode }), signal: bodyCtx.signal },
        "developer impl failed",
      );
      await bodyCtx.transcript.record({
        role: "developer",
        label: "impl-output",
        body: implOutput,
        meta: { length: implOutput.length },
      });

      // Phase 3: impl-review loop. Reviewer payload is a SUMMARY
      // (developer narrative + diff stat + diff fingerprint), not the
      // raw diff. Transcripts still keep the full diff for inspection.
      const initialDiff = readStagedDiff(ctx.repoRoot) || implOutput;
      const initialDiffStat = readStagedDiffStat(ctx.repoRoot);
      await bodyCtx.transcript.record({
        role: "developer",
        label: "impl-diff",
        body: initialDiff,
        meta: { length: initialDiff.length, fromGitDiff: readStagedDiff(ctx.repoRoot).length > 0 ? "yes" : "no" },
      });
      const implLabel = parentContext ? "Files changed by this followup" : "Files changed by this task";
      const originalImplSummary = composeImplSummary({
        finalText: implOutput,
        diffStat: initialDiffStat,
        diffBody: initialDiff,
        label: implLabel,
        transcriptHints: { implOutputName: "developer-impl-output", implDiffName: "developer-impl-diff" },
      });
      const innerImplReviewer = makeReviewer(
        runSteeredSpawnText,
        reviewer,
        (payload, prior) => {
          if (!prior) {
            return [
              `Review the implementation of ${parentContext ? "this followup" : "this single-task plan"}.`,
              "",
              `If you want to inspect specific files mentioned in the summary, your read/grep/find/ls tools operate on the current working directory (${ctx.repoRoot}); the implementation is staged but NOT yet committed there. Use this for spot-checks; do not enumerate every changed file.`,
              "",
              payload,
              REVIEWER_TDD_POLICY({ tddMode: effectiveTddMode, gitMode: effectiveGitMode }),
            ].join("\n");
          }
          return composeImplVerifyFixesPrompt({
            milestoneId: slug,
            cwd: ctx.repoRoot,
            originalImplSummary,
            priorVerdictText: prior.verdictText,
            currentFixSummary: payload,
            transcriptHints: { priorVerdictName: "reviewer-review-impl" },
            tddMode: effectiveTddMode,
            gitMode: effectiveGitMode,
          });
        },
        "impl reviewer failed",
        undefined,
        undefined,
        ctx.repoRoot,
      );
      let implRound = 0;
      const implReviewerFn: typeof innerImplReviewer = async (payload, prior, signal) => {
        implRound += 1;
        const result = await innerImplReviewer(payload, prior, signal);
        await bodyCtx.transcript.record({
          role: "reviewer",
          label: "review-impl",
          round: implRound,
          body: result.verdictText,
          status: result.verdict.verdict,
          meta: {
            P0: result.verdict.findings.P0.length,
            P1: result.verdict.findings.P1.length,
            P2: result.verdict.findings.P2.length,
            P3: result.verdict.findings.P3.length,
          },
        });
        return result;
      };
      const implRevise = async (
        findings: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
        _prevPayload: string,
      ) => {
        const actualPriorDiff = readStagedDiff(ctx.repoRoot);
        const revisionFinalText = await runSteeredSpawnText(
          developer,
          { task: composeDevRevise(actualPriorDiff, findings, { tddMode: effectiveTddMode, gitMode: effectiveGitMode }), signal: bodyCtx.signal },
          "developer revise failed",
        );
        const refreshedDiff = readStagedDiff(ctx.repoRoot);
        const refreshedStat = readStagedDiffStat(ctx.repoRoot);
        const finalBody = refreshedDiff.length > 0 ? refreshedDiff : actualPriorDiff;
        await bodyCtx.transcript.record({
          role: "developer",
          label: "revision-output",
          round: implRound,
          body: revisionFinalText,
          meta: { length: revisionFinalText.length },
        });
        await bodyCtx.transcript.record({
          role: "developer",
          label: "revision-impl",
          round: implRound,
          body: finalBody,
          meta: { length: finalBody.length, fromGitDiff: refreshedDiff.length > 0 ? "yes" : "no" },
        });
        return composeImplSummary({
          finalText: revisionFinalText,
          diffStat: refreshedStat,
          diffBody: finalBody,
          label: "Current cumulative file changes (includes prior round's work + this round's fix)",
          transcriptHints: { implOutputName: "developer-revision-output", implDiffName: "developer-revision-impl" },
        });
      };
      const impl = await runLoopWithPartialOutput(
        runLoop,
        {
          initialPayload: originalImplSummary,
          reviewer: implReviewerFn,
          revise: implRevise,
          maxRounds: implementationMaxRounds,
          signal: bodyCtx.signal,
        },
        { repoRoot: ctx.repoRoot, slug, subfolder: "impl-review" },
      );

      // Phase 4: configured after-verification hook with fix-loop.
      // On gate failure, the helper synthesizes a P0 finding from the
      // typed VerificationGateFailure and routes it through the same
      // dev/reviewer pair (`implRevise` / `implReviewerFn`) for at most
      // `implementationMaxRounds - implRound` more rounds, then re-runs
      // the gate. Budget is shared with the impl-review loop above
      // because `implReviewerFn` increments `implRound` on each call.
      // `phase: "before"` gates retain their direct-throw behavior.
      await runVerificationGateWithFixLoop({
        gate: {
          toolName: profile.toolName,
          cwd: ctx.repoRoot,
          phase: "after",
          verification: input.verification ?? profileDefaults?.verification,
          legacyVerifyCommand: input.verifyCommand,
          reporter: bodyCtx.reporter,
          checkpoints: bodyCtx.checkpoints,
          cache: bodyCtx.verificationCache,
          persistentCachePath: bodyCtx.verificationCachePath,
          agent: {
          member: reviewer,
          // Route through makeSpawnHelper so steering guidance reaches the
          // verifier-agent prompt the same way it reaches developer/planner.
          spawnAgent: (member, task) => sp.spawn(member, task, member.role),
        },
        },
        lastApprovedPayload: impl.finalPayload,
        remainingRounds: implementationMaxRounds - implRound,
        callbacks: {
          runDeveloperRevise: async ({ findings, priorPayload }) =>
            implRevise(findings, priorPayload),
          runReviewer: async ({ payload, prior }) =>
            implReviewerFn(
              payload,
              {
                findings: prior.verdict,
                verdictText: prior.verdictText,
                payload: prior.priorPayload,
              },
              bodyCtx.signal,
            ),
          transcript: bodyCtx.transcript,
          reporter: bodyCtx.reporter,
        },
      });

      // Phase 5: commit. In git mode both tools must produce a commit;
      // otherwise the workflow has effectively done nothing. If the developer
      // never staged anything, refuse rather than reporting approved with
      // commitSha=undefined. In no-git mode (gitMode='off') skip entirely.
      const commitMessage = parentContext
        ? `feat(${slug}): followup ${title}`
        : `feat(${slug}): ${title}`;
      let commit: string | undefined;
      if (effectiveGitMode !== "off") {
        const commitResult = commitStaged(profile.toolName, ctx.repoRoot, commitMessage);
        if (!commitResult) {
          throw new WorkflowStateError({
            toolName: ctx.toolName ?? profile.errorPrefix,
            description: "developer produced no staged changes; nothing to commit (workflow refuses to report success)",
            resumeHint: `invoke ${profile.resumeToolName} { resume: '${slug}' } after staging the intended changes`,
            details: { slug },
          });
        }
        commit = commitResult;
      }

      // Phase 6: push decision. Default: skip. No-op in no-git mode.
      let pushed = false;
      if (effectiveGitMode !== "off" && commit && input.shouldPush) {
        const wantsPush = await input.shouldPush();
        if (wantsPush) {
          const r = spawnSync("git", ["push"], { cwd: ctx.repoRoot, encoding: "utf8" });
          if (r.status !== 0) {
            throw new WorkflowStateError({
              toolName: ctx.toolName ?? profile.errorPrefix,
              description: `git push failed: ${r.stderr.trim()}`,
              resumeHint: "fix the push problem (auth/permissions/branch tracking) and rerun, or skip the push",
              details: { slug, stderr: r.stderr.trim() },
            });
          }
          pushed = true;
        }
      }

      // Phase 7: pr-description. Skip in no-git mode.
      let prDescriptionPath: string | undefined;
      if (effectiveGitMode !== "off") {
        prDescriptionPath = await generatePrDescription({
          repoRoot: ctx.repoRoot,
          slug,
          title,
          gitRange: "-1",
        });
      }

      return {
        slug,
        approved: true,
        rounds: { plan: plan.roundsUsed, impl: impl.roundsUsed },
        commitSha: commit,
        prDescriptionPath,
        pushed,
        revisionMetrics,
      } satisfies SfTeamTaskResult;
    },
  );

  const result: SfTeamTaskResult = (
    orchestrated.result ?? {
      slug,
      approved: false,
      rounds: { plan: 0, impl: 0 },
      pushed: false,
      revisionMetrics,
    }
  );
  if (orchestrated.performanceReportPath) result.performanceReportPath = orchestrated.performanceReportPath;
  if (orchestrated.costSummary) result.costSummary = orchestrated.costSummary;
  return result;
}

/**
 * Plan-brief composer. With `parentContext`, prepends a paragraph
 * referencing the parent slug and includes the parent's milestone plan
 * for the planner to anchor on. Without `parentContext`, the brief is
 * the existing single-task brief.
 */
function composePlanBrief(
  input: SfTeamTaskInput,
  parentContext?: { slug: string; parentMilestonePlan: string },
  opts?: { tddMode?: "on" | "off" | "auto" },
): string {
  if (!parentContext) {
    return [
      `Draft a single-file task plan for: ${input.title}`,
      "",
      "Brief:",
      input.brief ?? "(no brief)",
      PLANNER_TDD_REMINDER({ tddMode: opts?.tddMode }),
    ].join("\n");
  }
  return [
    `Draft a single-file followup plan for: ${input.title}`,
    "",
    `This is a follow-up to plan **${parentContext.slug}**. The parent's milestone plan is shown below for reference. Plan only the changes described next; do **not** edit the parent's files unless the description explicitly asks for it.`,
    "",
    "## Brief",
    input.brief ?? "(no brief)",
    "",
    "## Parent plan context",
    parentContext.parentMilestonePlan,
    PLANNER_TDD_REMINDER({ tddMode: opts?.tddMode }),
  ].join("\n");
}

function composePlanRevise(
  prev: string,
  v: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
  parentContext?: { slug: string; parentMilestonePlan: string },
  opts?: { tddMode?: "on" | "off" | "auto" },
): string {
  if (!parentContext) {
    return [
      "Revise the task plan to address findings:",
      formatFindings(v.findings),
      "",
      "Prior plan:",
      prev,
      PLANNER_TDD_REMINDER({ tddMode: opts?.tddMode }),
    ].join("\n");
  }
  return [
    `Revise the followup plan to address findings:`,
    formatFindings(v.findings),
    "",
    "## Prior plan",
    prev,
    "",
    "## Parent plan context",
    parentContext.parentMilestonePlan,
    PLANNER_TDD_REMINDER({ tddMode: opts?.tddMode }),
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

async function maybeAskForBrief(
  brief: string | undefined,
  ctx: {
    ui?: ExtensionUIContext;
    signal?: AbortSignal;
    askUserKeyPrefix: "task" | "followup";
  },
): Promise<string | undefined> {
  const trimmed = (brief ?? "").trim();
  if (trimmed.length >= 8) return brief;
  if (!ctx.ui) return brief;
  const { AskUser } = await import("../ask-user");
  const askUser = new AskUser(ctx.ui);
  const briefAnswer = await askUser.input({
    key: `${ctx.askUserKeyPrefix}.brief`,
    title: ctx.askUserKeyPrefix === "followup"
      ? "What should this follow-up address?"
      : "What does this task need to do?",
    placeholder: "Describe the change in 1-2 sentences",
    signal: ctx.signal,
  });
  const constraints = await askUser.input({
    key: `${ctx.askUserKeyPrefix}.constraints`,
    title: "Constraints (optional)",
    placeholder: "Files to touch, must-haves, things to avoid — leave blank to skip",
    signal: ctx.signal,
  });
  const parts: string[] = [];
  if (trimmed.length > 0) parts.push(trimmed);
  if (briefAnswer && briefAnswer.trim().length > 0) parts.push(briefAnswer.trim());
  if (constraints && constraints.trim().length > 0) parts.push(`Constraints: ${constraints.trim()}`);
  return parts.length > 0 ? parts.join("\n\n") : brief;
}

/**
 * Developer brief for the impl phase. The text is identical for task and
 * followup; the followup-only difference (parent context) lives in the
 * planner brief, not here.
 */
export function composeDeveloperBrief(
  plan: string,
  opts?: { tddMode?: "on" | "off" | "auto"; gitMode?: "on" | "off" },
): string {
  return [
    "Implement the following task plan in the current working tree.",
    composeDeveloperSystemPreamble({ gitMode: opts?.gitMode }),
    composeTddContract({ tddMode: opts?.tddMode, gitMode: opts?.gitMode }),
    "",
    "## Plan",
    "",
    plan,
  ].join("\n");
}

export function composeDevRevise(
  prev: string,
  v: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
  opts?: { tddMode?: "on" | "off" | "auto"; gitMode?: "on" | "off" },
): string {
  return [
    "Update the implementation to address the reviewer findings below.",
    composeDeveloperSystemPreamble({ gitMode: opts?.gitMode }),
    composeTddContract({ tddMode: opts?.tddMode, gitMode: opts?.gitMode }),
    "",
    "## Reviewer findings to address",
    formatFindings(v.findings),
    "",
    "## Prior diff",
    prev,
  ].join("\n");
}

export const TASK_WORKFLOW_PROFILE: RunTaskWorkflowProfile = {
  toolName: "sf_team_task",
  ownerTool: "sf_team_task",
  resumeToolName: "sf_team_task_resume",
  resolveConfigDefaults: (defaults) => {
    const t = defaults?.task;
    if (!t) return undefined;
    return {
      allow_dirty: t.allow_dirty,
      use_worktree: t.use_worktree,
      create_branch: t.create_branch,
      verification: t.verification,
    };
  },
  askUserKeyPrefix: "task",
  errorPrefix: "sf_team_task",
};

export const FOLLOWUP_WORKFLOW_PROFILE: RunTaskWorkflowProfile = {
  toolName: "sf_team_followup",
  ownerTool: "sf_team_followup",
  resumeToolName: "sf_team_followup_resume",
  resolveConfigDefaults: (defaults) => {
    const f = defaults?.followup;
    if (!f) return undefined;
    // Followup runs in cwd like task. After M3 cleanup the followup
    // config schema dropped `reuse_parent_worktree`, so we only project
    // allow_dirty + verification. use_worktree/create_branch are forced
    // to task-equivalent defaults since followup behaves like task.
    return {
      allow_dirty: f.allow_dirty,
      use_worktree: false,
      create_branch: false,
      verification: f.verification,
    };
  },
  askUserKeyPrefix: "followup",
  errorPrefix: "sf_team_followup",
};
