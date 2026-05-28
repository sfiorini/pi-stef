import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { jiraKeyFromBrowseUrl } from "@pi-stef/atlassian";

import { AskUser } from "../ask-user";
import {
  buildSequentialExecutionStrategyArtifact,
  parseExecutionStrategyText,
  validateExecutionStrategy,
  type ExecutionStrategy,
} from "../plan/execution-strategy";
import { writePlanFolder } from "../plan/write";
import { EXECUTION_STRATEGY_FILE } from "../plan/paths";
import { slugify } from "../plan/slug";
import { parseTrackerText, type ParsedTracker } from "../plan/tracker";
import { runOrchestrator } from "../orchestrator/run";
import { EmptyPlanError, type EmptyPlanReason } from "../orchestrator/empty-plan-error";
import { DEFAULT_CONFIG, type ResearcherPolicy, type ResolvedDefaults, type ThinkingLevel } from "../config/schema";
import { effectiveTmuxManager, effectiveUi, planReviewMaxRounds, workflowProfile } from "../config/workflow";
import { fetchExternalContext, scanRefs } from "../research/external-fetch";
import { runResearcher } from "../research/run";
import { askResearchQuestions } from "../research/qa";
import { composeEnrichedBrief } from "../research/compose";
import type { JiraContextResult } from "../research/jira-context";
import type { ExternalFetcher, ExternalFetchResult, ExternalRef, ResearchAnalysis } from "../research/types";
import type { PlanRevisionMetrics } from "../plan/revision-metrics";
import type { AgentRole, TeamMember } from "../runtime/types";
import { isApproved, type ReviewerVerdict } from "../review/parse";
import type { WorkflowToolName } from "@pi-stef/agent-workflows";
import { revisePlanWithPatchOrFallback } from "./plan-revision";
import { normalOrResumeValue, resolveToolResume } from "./resume";
import { composePlanVerifyFixesPrompt, defaultDeps, EXECUTION_STRATEGY_JSON_EXAMPLE, makeReviewer, makeRunStringReviewLoop, makeSpawnHelper, PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE, runLoopWithPartialOutput, truncatePayloadBytes, type ToolDeps } from "./shared";
import { reapplySteeringPlanNotes } from "../steering/guidance-plan-notes-reapply";
import { enforcePauseAtSafeBoundary } from "../steering/pause-enforcement";
import { decideSteeringInstruction, decideSteeringInstructions } from "../steering/decider";
import { applySteeringBacktrack } from "../steering/backtrack";
import { PLANNER_TDD_REMINDER } from "./tdd-policy";
import { resolveRuntime } from "../config/resolve-runtime";
import { runConfiguredVerification, type SfTeamVerificationConfigInput } from "./verification-stage";
import type { CostSummary } from "../orchestrator/cost";
import type { GitMode, TddMode } from "../config/schema";

export interface SfTeamPlanInput {
  /** Title used for both the slug and the planner's brief. */
  title?: string;
  /** Resume an existing sf_team_plan workflow from a slug or plan-folder path. */
  resume?: string;
  /** Optional brief / requirements text passed to the planner. */
  brief?: string;
  /** Override agents (test injection / config). */
  planner?: TeamMember;
  reviewer?: TeamMember;
  researcher?: TeamMember;
  /** Max review rounds (default 10). */
  maxRounds?: number;
  /** When true (default), write 5-file plan folder at end. */
  writeFolder?: boolean;
  /**
   * When provided, skip the researcher phase entirely and use this pre-computed
   * analysis. sf_team_auto uses this so the chain runs the researcher exactly
   * once and shares the result across plan + implement.
   */
  analysisOverride?: ResearchAnalysis | null;
  /** Pre-computed Q&A answers, keyed by question id. Used by analysisOverride callers. */
  answersOverride?: Record<string, string>;
  /** External-context fetcher; defaults to no-op (refs become openQuestions). */
  externalFetcher?: ExternalFetcher;
  verification?: SfTeamVerificationConfigInput;
  /** Absolute or relative path for plan folders. Defaults to ./ai_plan/. */
  aiPlanPath?: string;
  gitMode?: GitMode;
  tddMode?: TddMode;
}

export interface SfTeamPlanResult {
  slug: string;
  approved: boolean;
  rounds: number;
  finalPlan: string;
  folderPath?: string;
  performanceReportPath?: string;
  costSummary?: CostSummary;
  agentSettings: AgentSettingsDetails;
  researcherDecision: ResearcherDecision;
  revisionMetrics: PlanRevisionMetrics[];
  /**
   * Optional Atlassian Jira context fetch outcome, set when the brief
   * contained Jira references and the orchestrator attempted a fetch.
   * Undefined when the caller supplied `analysisOverride` (the auto-chain
   * second-pass path skips the fetch entirely).
   */
  jiraContext?: JiraContextResult;
}

export type AgentSettingsSource = "default" | "resolved-config" | "input";

export interface EffectiveAgentSettings {
  model: string;
  thinking: ThinkingLevel;
  heartbeatMs: number;
  source: {
    model: AgentSettingsSource;
    thinking: AgentSettingsSource;
    heartbeatMs: AgentSettingsSource;
  };
}

export type AgentSettingsDetails = Record<AgentRole, EffectiveAgentSettings>;

export interface ResearcherDecision {
  policy: ResearcherPolicy;
  action: "used" | "skipped";
  reason: string;
  externalRefs: number;
  signals: string[];
}

/**
 * sf_team_plan: explore -> Q&A -> planner-draft -> reviewer loop -> write folder.
 *
 * The reviewer loop's `revise` callback re-spawns the planner with the
 * { prior_plan, findings } context and returns the planner's new plan as the
 * next payload. The plan-revise-forwarding test asserts the second reviewer
 * call sees the revised plan.
 */
export function createSfTeamPlan(rawDeps: Partial<ToolDeps> = {}) {
  const deps: ToolDeps = { ...defaultDeps, ...rawDeps };
  const runLoop = makeRunStringReviewLoop(deps);

  return async function sfTeamPlan(
    input: SfTeamPlanInput,
    ctx: {
      repoRoot: string;
      signal?: AbortSignal;
      ui?: ExtensionUIContext;
      configDefaults?: ResolvedDefaults;
      /** Forwarded to runOrchestrator; set by `sf_team_auto` so plan + implement decorate the same tmux session. */
      tmuxSessionAliasOverride?: string;
      /** Owner tool used for nested auto resume ownership checks. */
      resumeOwnerTool?: WorkflowToolName;
      /** Used by sf_team_auto so plan.verification does not run during the nested plan phase. */
      suppressPlanVerification?: boolean;
      /** Pi tool surface name fronting this run; used by typed errors. */
      toolName?: string;
      /** Resolved absolute plan-folder root (injected by register.ts via resolveRuntime). */
      planRoot?: string;
      gitMode?: "on" | "off";
      tddMode?: "on" | "off" | "auto";
    },
  ): Promise<SfTeamPlanResult> {
    // Resolve planRoot / gitMode / tddMode early so resume discovery can
    // search the correct plan root (candidatePlanRoots).
    const runtime = (ctx.planRoot !== undefined)
      ? { planRoot: ctx.planRoot, gitMode: ctx.gitMode ?? "on", tddMode: ctx.tddMode ?? "auto" }
      : resolveRuntime({
          prompt: { aiPlanPath: input.aiPlanPath, gitMode: input.gitMode, tddMode: input.tddMode },
          defaults: ctx.configDefaults ?? DEFAULT_CONFIG,
          repoRoot: ctx.repoRoot,
        });
    const planRoot = runtime.planRoot;
    const gitMode = runtime.gitMode;
    const tddMode = runtime.tddMode;

    const resume = await resolveToolResume({
      repoRoot: ctx.repoRoot,
      toolName: ctx.resumeOwnerTool ?? "sf_team_plan",
      input,
      normalField: "title",
      candidatePlanRoots: [planRoot],
    });
    // If resume was found at an external plan root (e.g. via global index),
    // use the parent of the resolved folderPath as the effective planRoot so
    // all runtime artifacts (transcripts, reports, etc.) land in the right place.
    const effectivePlanRoot = resume ? path.dirname(resume.target.folderPath) : planRoot;
    // Rehydrate gitMode/tddMode from persisted metadata when resuming and no
    // explicit prompt-level override was supplied. ctx.planRoot !== undefined
    // means sf_team_auto already resolved modes — don't touch them.
    const effectiveGitMode: "on" | "off" = (resume?.metadata?.gitMode != null && ctx.planRoot === undefined && (input.gitMode === undefined || input.gitMode === "auto"))
      ? resume.metadata.gitMode
      : gitMode;
    const effectiveTddMode: "on" | "off" | "auto" = (resume?.metadata?.tddMode != null && ctx.planRoot === undefined && (input.tddMode === undefined || input.tddMode === "auto"))
      ? resume.metadata.tddMode
      : tddMode;
    const title = normalOrResumeValue(input, "title", resume);
    const normalizedInput: SfTeamPlanInput = { ...input, title };
    const slug = resume?.target.slug ?? slugify(title);
    const agents = ctx.configDefaults?.agents ?? DEFAULT_CONFIG.agents;
    const planner = mergeMember(defaultPlanner(agents), input.planner);
    const reviewer = mergeMember(defaultReviewer(agents), input.reviewer);
    const researcher = mergeMember(defaultResearcher(agents), input.researcher);
    const ui = effectiveUi(ctx.ui, ctx.configDefaults);
    const maxRounds = planReviewMaxRounds(input.maxRounds, ctx.configDefaults);
    const planRevisionMode = ctx.configDefaults?.performance.plan_revision ?? DEFAULT_CONFIG.performance.plan_revision;
    const revisionMetrics: PlanRevisionMetrics[] = [];
    const baseAgentSource: AgentSettingsSource = ctx.configDefaults ? "resolved-config" : "default";
    const agentSettings = describeAgentSettings({
      planner,
      reviewer,
      developer: { role: "developer", ...agents.developer },
      researcher,
    }, {
      planner: settingSources(input.planner, baseAgentSource),
      reviewer: settingSources(input.reviewer, baseAgentSource),
      developer: settingSources(undefined, baseAgentSource),
      researcher: settingSources(input.researcher, baseAgentSource),
    });
    const promptForResearcher = composePromptForResearcher(normalizedInput);
    const researcherPolicy = ctx.configDefaults?.performance.researcher ?? DEFAULT_CONFIG.performance.researcher;

    const orchestrated = await runOrchestrator(
      {
        repoRoot: ctx.repoRoot,
        slug,
        toolName: "sf_team_plan",
        ownerTool: ctx.resumeOwnerTool,
        useWorktree: false,
        planRoot: effectivePlanRoot,
        gitMode: effectiveGitMode,
        tddMode: effectiveTddMode,
        signal: ctx.signal,
        ui,
        tmuxManager: effectiveTmuxManager(undefined, ctx.configDefaults),
        tmuxSessionAliasOverride: ctx.tmuxSessionAliasOverride,
        workflowProfile: workflowProfile(ctx.configDefaults),
        resumeMode: !!resume,
        reviewRoundLimits: {
          maxRounds: ctx.configDefaults?.review.max_rounds ?? DEFAULT_CONFIG.review.max_rounds,
          planMaxRounds: maxRounds,
          implementationMaxRounds: ctx.configDefaults?.review.implementation_max_rounds ?? DEFAULT_CONFIG.review.implementation_max_rounds,
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
        bodyCtx.steering.setPlanDecisionApplier(({ instruction, decision }) =>
          applySteeringBacktrack({
            repoRoot: ctx.repoRoot,
            slug,
            workflowId: bodyCtx.steering.workflowId,
            instruction,
            decision,
            planner,
            sp,
            transcript: bodyCtx.transcript,
            signal: bodyCtx.signal,
            // Planning-time steering has no implementation commit ledger, so
            // completed-work handling is forward-only plan/tracker rework.
            confirmCompletedWork: ui
              ? async (summary) => await ui.confirm("Backtrack completed sf-team work?", summary.message, { signal: bodyCtx.signal }) === true
              : undefined,
          })
        );
        await bodyCtx.steering.drain("workflow-start");
        await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });

        await runConfiguredVerification({
          toolName: "sf_team_plan",
          cwd: ctx.repoRoot,
          phase: "before",
          verification: ctx.suppressPlanVerification
            ? { timing: "off" }
            : input.verification ?? ctx.configDefaults?.plan.verification,
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

        // ──────────────────────────────────────────────────────────────────
        // Orchestrator-mediated workflow per the architecture decision:
        //   0. fetchJiraContext       (TS; calls atlassian package walker)
        //   1. fetchExternalContext   (TS, regex + injected fetcher)
        //   2. runResearcher          (pi subprocess; emits structured JSON)
        //   3. askResearchQuestions   (TS, drives ctx.ui.input/select)
        //   4. composeEnrichedBrief   (TS, pure)
        //   5. runPlannerDraft        (pi subprocess)
        //   6. runReviewLoopOrchestrated (planner ↔ reviewer until APPROVED)
        //   7. P3-only one-more-pass  (per the prompt's step 7)
        //   8. write 5-file plan folder
        // Each subprocess hands control back to the orchestrator; the
        // orchestrator decides the next phase.
        // ──────────────────────────────────────────────────────────────────

        const skipResearcher = "analysisOverride" in input;

        // Step 0: Jira context fetch. Skipped on the analysisOverride path
        // so the auto-chain (and any caller passing a pre-computed analysis)
        // never triggers a redundant fetch.
        const jiraContextResult: JiraContextResult | undefined = skipResearcher
          ? undefined
          : await deps.fetchJiraContext({
              title,
              brief: promptForResearcher,
              signal: bodyCtx.signal,
            });
        if (jiraContextResult) {
          await bodyCtx.transcript.record({
            role: "system",
            label: "jira-context",
            status:
              jiraContextResult.status === "used"
                ? "USED"
                : jiraContextResult.status === "failed"
                  ? "FAILED"
                  : "SKIPPED",
            body: JSON.stringify(jiraContextResult, null, 2),
            meta: {
              status: jiraContextResult.status,
              detectedKeys: jiraContextResult.detectedKeys.join(", "),
              fetchedCount: jiraContextResult.fetchedCount,
              reason: jiraContextResult.reason ?? "",
            },
          });
        }

        // Compute researcher decision now that we know the Jira outcome.
        const researcherDecision: ResearcherDecision = skipResearcher
          ? buildOverrideResearcherDecision(promptForResearcher, researcherPolicy)
          : decideResearcherWithJira(promptForResearcher, researcherPolicy, jiraContextResult);

        await bodyCtx.transcript.record({
          role: "system",
          label: "researcher-decision",
          status: researcherDecision.action === "used" ? "USED" : "SKIPPED",
          body: JSON.stringify(researcherDecision, null, 2),
          meta: {
            policy: researcherDecision.policy,
            action: researcherDecision.action,
            reason: researcherDecision.reason,
            externalRefs: researcherDecision.externalRefs,
            signals: researcherDecision.signals.join(", "),
          },
        });

        const shouldRunResearcher = !skipResearcher && researcherDecision.action === "used";
        const rawExternalContext: ExternalFetchResult = shouldRunResearcher
          ? await fetchExternalContext(promptForResearcher, {
              fetcher: input.externalFetcher,
              signal: bodyCtx.signal,
            })
          : { resolved: [], unresolved: [] };
        const externalContext = omitJiraRefsCoveredByAtlassianContext(rawExternalContext, jiraContextResult);

        const analysis: ResearchAnalysis | null = skipResearcher
          ? (input.analysisOverride ?? null)
          : shouldRunResearcher
            ? await runAgentWithSteeringDrain(async () => runResearcher({
                prompt: promptForResearcher,
                externalContext,
                jiraContextMarkdown: contextMarkdownForResearcher(jiraContextResult),
                researcher,
                spawn: (m, t, widgetAgentId) => sp.spawn(m, t, widgetAgentId),
                ui,
                signal: bodyCtx.signal,
                diagnosticsContext: { repoRoot: ctx.repoRoot, slug },
              }), bodyCtx.steering)
            : null;
        if (analysis) {
          await bodyCtx.transcript.record({
            role: "researcher",
            label: "analysis",
            body: JSON.stringify(analysis, null, 2),
            status: "OK",
            meta: { knownFacts: analysis.knownFacts.length, ambiguities: analysis.ambiguities.length, openQuestions: analysis.openQuestions.length },
          });
        }

        const answers: Record<string, string> = input.answersOverride
          ?? (analysis && ui
            ? await askResearchQuestions(analysis, ui, {
                repoRoot: ctx.repoRoot,
                slug,
                signal: bodyCtx.signal,
              })
            : {});

        // Fall back to the legacy brief-pump if researcher returned null AND we have UI.
        const fallbackBrief = analysis === null
          ? await maybeAskForBrief(normalizedInput.brief, { ui, signal: ctx.signal })
          : normalizedInput.brief;

        const enrichedBrief = composeEnrichedBrief({
          originalBrief: fallbackBrief,
          analysis,
          answers,
          externalContext,
          jiraContextMarkdown: jiraContextResult?.status === "used" ? jiraContextResult.markdown : undefined,
        });

        const initialBrief = composePlannerBrief(title, enrichedBrief, effectiveTddMode);
        const draft = await runAgentWithSteeringDrain(
          () => sp.spawnText(planner, { task: initialBrief, signal: bodyCtx.signal }, "planner draft failed"),
          bodyCtx.steering,
        );
        await bodyCtx.transcript.record({
          role: "planner",
          label: "draft",
          body: draft,
          meta: { length: draft.length },
        });
        // Deterministic plan-shape + execution-strategy gate. Runs after the
        // initial draft (label = "pre-review", round 0) AND after every
        // reviewer-driven revision (label = "mid-review-round-N", round = the
        // round we're feeding back to the reviewer). The gate is strictly
        // non-recursive: one self-revision per call. If the self-revision
        // ALSO leaves a deterministic failure, the gate records a
        // `still-failing` transcript entry and returns the still-bad plan to
        // the reviewer for normal processing — the reviewer round counter is
        // NOT inflated by gate trips. See task 2026-05-22-sf-team-strategy-
        // validator-gate-hardening.
        async function runDeterministicPlanGate(
          plan: string,
          round: number,
          label: "pre-review" | `mid-review-round-${number}`,
        ): Promise<string> {
          const findings = composeDeterministicPlanFindings(plan);
          if (!findings) return plan;
          await bodyCtx.transcript.record({
            role: "system",
            label: `deterministic-${label}`,
            status: "REVISE",
            body: formatFindingsForTranscript(findings),
          });
          const result = await revisePlanWithPatchOrFallback({
            mode: planRevisionMode,
            priorPlan: plan,
            findings,
            planner,
            sp,
            signal: bodyCtx.signal,
            transcript: bodyCtx.transcript,
            round,
            label: "plan",
            errorPrefix: `planner deterministic ${label} revision failed`,
            composeFullPrompt: () => composeReviseBrief(plan, findings, effectiveTddMode),
            extraContext:
              label === "pre-review"
                ? "This revision happens before the reviewer call. Fix only deterministic plan-shape or execution-strategy validation failures so the first reviewer round can focus on product/engineering issues."
                : `This revision happens between reviewer rounds (after round ${round}'s revision). Fix ONLY the deterministic plan-shape or execution-strategy validation failures listed below; do NOT undo the reviewer-driven changes from the prior revision.`,
          });
          revisionMetrics.push(result.metrics);
          const revised = result.plan;
          await bodyCtx.transcript.record({
            role: "planner",
            label: `deterministic-${label}-revision`,
            round,
            body: revised,
            meta: {
              length: revised.length,
              revisionMode: result.metrics.mode,
              patchAttempted: result.metrics.patchAttempted ? "yes" : "no",
              patchApplied: result.metrics.patchApplied ? "yes" : "no",
              fallbackUsed: result.metrics.fallbackUsed ? "yes" : "no",
            },
          });
          // Re-check: did the self-revision actually fix the deterministic
          // failures? Strictly non-recursive — we record the outcome and
          // return whatever the planner produced, no further planner calls.
          const residual = composeDeterministicPlanFindings(revised);
          if (residual) {
            await bodyCtx.transcript.record({
              role: "system",
              label: `deterministic-${label}-still-failing`,
              status: "REVISE",
              body: formatFindingsForTranscript(residual),
            });
          } else {
            await bodyCtx.transcript.record({
              role: "system",
              label: `deterministic-${label}-OK`,
              status: "OK",
              body: "Deterministic plan-shape + execution-strategy validation passed after self-revision.",
            });
          }
          return revised;
        }

        let reviewCandidate = await runDeterministicPlanGate(draft, 0, "pre-review");

        // Wrap the reviewer + revise callbacks so EVERY round's verdict text
        // and revised draft land in the transcript folder. The orchestrator
        // owns round numbering so the user can read the loop chronologically
        // without inspecting in-memory state.
        let roundNum = 0;
        // Hold the round-1 plan body in this closure so round 3+ embed it
        // verbatim regardless of `runReviewLoop`'s immediately-previous-
        // round prior tracking. Captured below from the planner's draft.
        let originalPlan: string | undefined;
        let strategyValidationExhausted = false;
        const innerReviewerFn = makeReviewer(
          sp.spawnText,
          reviewer,
          (payload, prior) => {
            // Round 1: full fresh review against the byte-capped plan.
            // Cap defends against E2BIG on a runaway plan body — the
            // planner's transcript still holds the uncapped version.
            // Capture the round-1 payload as `originalPlan` so round 2+
            // anchor to it (instead of drifting through immediately-
            // previous payloads as `runReviewLoop` does by default).
            if (!prior) {
              originalPlan = payload;
              return composeInitialPlanReviewPrompt(payload);
            }
            // Round 2+: anchor to the round-1 plan, embed prior verdict
            // (capped) + current revised plan (capped). Section labels
            // stay symmetric with the impl-review path.
            // Helper auto-caps each input internally; callers pass raw text.
            return composePlanVerifyFixesPrompt({
              label: "plan",
              originalPlan: originalPlan ?? "",
              priorVerdictText: prior.verdictText,
              currentPlan: payload,
            });
          },
          "reviewer failed",
          undefined,
          undefined,
          ctx.repoRoot,
        );
        const reviewerFn: typeof innerReviewerFn = async (payload, prior, signal) => {
          roundNum += 1;
          const result = await innerReviewerFn(payload, prior, signal);
          const strategyFeedback = isApproved(result.verdict)
            ? composeStrategyValidationFeedback(payload)
            : null;
          const finalResult = strategyFeedback && roundNum < maxRounds
            ? strategyFeedback
            : result;
          if (strategyFeedback && roundNum >= maxRounds) {
            strategyValidationExhausted = true;
          }
          await bodyCtx.transcript.record({
            role: "reviewer",
            label: "review",
            round: roundNum,
            body: finalResult.verdictText,
            status: finalResult.verdict.verdict,
            meta: {
              P0: finalResult.verdict.findings.P0.length,
              P1: finalResult.verdict.findings.P1.length,
              P2: finalResult.verdict.findings.P2.length,
              P3: finalResult.verdict.findings.P3.length,
            },
          });
          return finalResult;
        };
        const revise = async (findings: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } }, prevPlan: string) => {
          const result = await revisePlanWithPatchOrFallback({
            mode: planRevisionMode,
            priorPlan: prevPlan,
            findings,
            planner,
            sp,
            signal: bodyCtx.signal,
            transcript: bodyCtx.transcript,
            round: roundNum,
            label: "plan",
            errorPrefix: "planner revision failed",
            composeFullPrompt: () => composeReviseBrief(prevPlan, findings, effectiveTddMode),
          });
          revisionMetrics.push(result.metrics);
          await bodyCtx.transcript.record({
            role: "planner",
            label: "revision",
            round: roundNum,
            body: result.plan,
            meta: {
              length: result.plan.length,
              revisionMode: result.metrics.mode,
              patchAttempted: result.metrics.patchAttempted ? "yes" : "no",
              patchApplied: result.metrics.patchApplied ? "yes" : "no",
              fallbackUsed: result.metrics.fallbackUsed ? "yes" : "no",
            },
          });
          // Deterministic mid-review gate. Run the same shape + strategy
          // validator we used on the initial draft against the revised plan,
          // BEFORE handing it back to the reviewer. If the gate fires, the
          // planner gets one self-revision to fix the deterministic failure
          // without burning a reviewer round. Strictly non-recursive.
          return runDeterministicPlanGate(result.plan, roundNum, `mid-review-round-${roundNum}`);
        };
        let review = await runLoopWithPartialOutput(
          runLoop,
          {
            initialPayload: reviewCandidate,
            reviewer: reviewerFn,
            revise,
            maxRounds,
            signal: bodyCtx.signal,
          },
          { repoRoot: ctx.repoRoot, slug },
        );

        // P3-only one-more-pass (step 7 of the architecture). Reviewer
        // returned APPROVED but with cosmetic findings; do a single planner
        // revision to fix them, then proceed without a further reviewer round.
        const p3List = review.approved.findings.P3;
        if (p3List.length > 0) {
          const p3RevisedDraft = await revise(
            { findings: { P0: [], P1: [], P2: [], P3: p3List } },
            review.finalPayload,
          );
          await bodyCtx.transcript.record({
            role: "system",
            label: "p3-only-fixup-applied",
            body: `Applied P3-only fixup pass after APPROVED. ${p3List.length} cosmetic finding(s) addressed; no further reviewer round.`,
            status: "OK",
          });
          review = { ...review, finalPayload: p3RevisedDraft };
        }

        // Plan-shape validation: catch the failure mode where the planner
        // returned a refusal/empty/structureless payload that the reviewer
        // (an LLM) format-approved. The orchestrator runs three independent
        // validators; ANY failure rejects the plan with a friendly notify
        // before any plan files get written.
        const validationFailure = detectPlanShapeFailure(review.finalPayload);
        if (validationFailure) {
          const message = `Planner returned an empty/refusal plan (${validationFailure.reason}) — see ai_plan/${slug}/diagnostics-*.log`;
          // Transcript first (best-effort) so the rejected payload is
          // preserved for post-mortem under transcript/<NNNN>-system-validation-failed-FAILED.md.
          await bodyCtx.transcript.record({
            role: "system",
            label: "validation-failed",
            body: review.finalPayload,
            status: "FAILED",
            meta: { reason: validationFailure.reason },
          });
          ui?.notify?.(message, "error");
          throw new EmptyPlanError({
            rawPayload: review.finalPayload,
            reason: validationFailure.reason,
            toolName: ctx.toolName ?? "sf_team_plan",
            slug,
            resumeTool: ctx.toolName?.startsWith("sf_team_auto") ? "sf_team_auto_resume" : "sf_team_plan_resume",
          });
        }

        // Phase 4: write the 5-file plan folder.
        let folderPath: string | undefined;
        if (input.writeFolder !== false) {
          // Parse milestone headings ONCE and reuse for tracker + runbook + transcript.
          const milestones = extractMilestones(review.finalPayload);
          const storyTracker = deriveStoryTracker(review.finalPayload);
          const tracker = parseTrackerText(storyTracker);
          const executionStrategy = resolveExecutionStrategyForPlan(review.finalPayload, tracker);
          if (executionStrategy.validationFailure) {
            const label = strategyValidationExhausted
              ? "strategy-validation-fallback-after-retries"
              : "strategy-validation-failed";
            const message = strategyValidationExhausted
              ? `Planner execution strategy still failed validation after review retries; writing sequential fallback (${executionStrategy.validationFailure.message}).`
              : `Planner execution strategy failed validation; writing sequential fallback (${executionStrategy.validationFailure.message}).`;
            await bodyCtx.transcript.record({
              role: "system",
              label,
              status: "FAILED",
              body: [
                message,
                "",
                "## Attempted strategy",
                "",
                "```json",
                JSON.stringify(executionStrategy.validationFailure.attemptedStrategy, null, 2),
                "```",
              ].join("\n"),
              meta: { reason: executionStrategy.validationFailure.message },
            });
            ui?.notify?.(message, "warning");
          }
          folderPath = await writePlanFolder(ctx.repoRoot, {
            kind: "five-file",
            slug,
            executionStrategyJson: JSON.stringify(executionStrategy.strategy, null, 2),
            files: {
              "original-plan.md": review.finalPayload,
              "milestone-plan.md": review.finalPayload,
              "story-tracker.md": storyTracker,
              "continuation-runbook.md": composeContinuationRunbook({
                slug,
                title,
                milestones,
                planReviewRounds: review.roundsUsed,
              }),
              "final-transcript.md": composeFinalTranscript({
                slug,
                title,
                milestones,
                planReviewRounds: review.roundsUsed,
              }),
            },
          }, effectivePlanRoot);
          // Re-apply steering plan notes that the drain may have written to
          // the per-instruction milestone-plan.md / final-transcript.md
          // BEFORE this wholesale writePlanFolder ran. appendSteeringPlanNote
          // is idempotent on the (source:instructionId) provenance marker,
          // so notes that were not clobbered are skipped.
          await reapplySteeringPlanNotes({
            store: bodyCtx.steering.store,
            planFolder: folderPath,
            repoRoot: ctx.repoRoot,
            reporter: bodyCtx.reporter,
          });
        }
        await runConfiguredVerification({
          toolName: "sf_team_plan",
          cwd: ctx.repoRoot,
          phase: "after",
          verification: ctx.suppressPlanVerification
            ? { timing: "off" }
            : input.verification ?? ctx.configDefaults?.plan.verification,
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
        await bodyCtx.steering.drain("before-final-completion");
        await enforcePauseAtSafeBoundary(bodyCtx.steering, { ui, signal: bodyCtx.signal });
        return {
          slug,
          approved: true,
          rounds: review.roundsUsed,
          finalPlan: review.finalPayload,
          folderPath,
          agentSettings,
          researcherDecision,
          revisionMetrics,
          jiraContext: jiraContextResult,
        } satisfies SfTeamPlanResult;
      },
    );
    const result: SfTeamPlanResult = (
      orchestrated.result ?? {
        slug,
        approved: false,
        rounds: 0,
        finalPlan: "",
        agentSettings,
        researcherDecision: {
          policy: researcherPolicy,
          action: "skipped",
          reason: "resume declined",
          externalRefs: 0,
          signals: [],
        },
        revisionMetrics,
        jiraContext: undefined,
      }
    );
    if (orchestrated.performanceReportPath) result.performanceReportPath = orchestrated.performanceReportPath;
    if (orchestrated.costSummary) result.costSummary = orchestrated.costSummary;
    return result;
  };
}

/**
 * Run the three plan-shape validators against an approved plan body.
 * Returns null when the plan is acceptable (all three pass), or
 * `{ reason }` for the FIRST validator that fails. Order: too-short
 * (cheapest), no-milestones, no-stories. Mirrors the order in the M1
 * acceptance criteria.
 */
function detectPlanShapeFailure(plan: string): { reason: EmptyPlanReason } | null {
  if (plan.length < 200) return { reason: "too-short" };
  if (!hasRealMilestones(plan)) return { reason: "no-milestones" };
  if (!hasRealStories(plan)) return { reason: "no-stories" };
  return null;
}

function composeInitialPlanReviewPrompt(payload: string): string {
  const cappedPayload = truncatePayloadBytes(payload, "planner-draft");
  return [
    "Review the following plan and return the standard verdict structure.",
    "",
    PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE,
    "",
    "--- PLAN ---",
    cappedPayload,
    "--- END PLAN ---",
  ].join("\n");
}

interface PlanExecutionStrategyResolution {
  strategy: ExecutionStrategy;
  validationFailure?: {
    message: string;
    attemptedStrategy: unknown;
  };
}

function resolveExecutionStrategyForPlan(plan: string, tracker: ParsedTracker): PlanExecutionStrategyResolution {
  let parsed: ExecutionStrategy | null;
  try {
    parsed = parseExecutionStrategyText(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      strategy: buildSequentialExecutionStrategyArtifact(tracker),
      validationFailure: {
        message,
        attemptedStrategy: extractExecutionStrategyJsonForTranscript(plan) ?? { error: message },
      },
    };
  }
  if (!parsed) return { strategy: buildSequentialExecutionStrategyArtifact(tracker) };
  try {
    return {
      strategy: executionStrategyArtifactFromResolved(
        validateExecutionStrategy(parsed, tracker, { source: "plan" }),
      ),
    };
  } catch (error) {
    return {
      strategy: buildSequentialExecutionStrategyArtifact(tracker),
      validationFailure: {
        message: error instanceof Error ? error.message : String(error),
        attemptedStrategy: parsed,
      },
    };
  }
}

function composeStrategyValidationFeedback(
  plan: string,
): { verdictText: string; verdict: ReviewerVerdict } | null {
  if (detectPlanShapeFailure(plan)) return null;
  const finding = composeExecutionStrategyValidationFinding(plan);
  if (!finding) return null;

  const verdict: ReviewerVerdict = {
    summary: "The automated reviewer approved the plan body, but deterministic execution-strategy validation failed before plan files could be written.",
    findings: {
      P0: [],
      P1: [],
      P2: [finding],
      P3: [],
    },
    verdict: "REVISE",
  };
  return {
    verdict,
    verdictText: [
      "## Summary",
      verdict.summary,
      "",
      "## Findings",
      "### P0",
      "- None.",
      "### P1",
      "- None.",
      "### P2",
      `- ${finding}`,
      "### P3",
      "- None.",
      "",
      "## Verdict",
      "VERDICT: REVISE",
    ].join("\n"),
  };
}

function composeDeterministicPlanFindings(plan: string): { findings: ReviewerVerdict["findings"] } | null {
  const shapeFailure = detectPlanShapeFailure(plan);
  if (shapeFailure) {
    return {
      findings: {
        P0: [],
        P1: [],
        P2: [
          `Plan shape failed deterministic validation: ${shapeFailure.reason}. Return a complete plan with real milestone headings and story bullets before reviewer review.`,
        ],
        P3: [],
      },
    };
  }

  const strategyFinding = composeExecutionStrategyValidationFinding(plan);
  if (!strategyFinding) return null;
  return {
    findings: {
      P0: [],
      P1: [],
      P2: [strategyFinding],
      P3: [],
    },
  };
}

function composeExecutionStrategyValidationFinding(plan: string): string | null {
  const tracker = parseTrackerText(deriveStoryTracker(plan));
  const resolution = resolveExecutionStrategyForPlan(plan, tracker);
  if (!resolution.validationFailure) return null;

  return [
    `Execution strategy failed validation: ${resolution.validationFailure.message}.`,
    "`## Execution Strategy` must use milestone wave objects and per-milestone story wave objects; array-of-arrays or top-level `milestones` story metadata is not valid.",
    "",
    "writeSet path validator rules:",
    "  - Rejected chars: `*`, `?` (shell-glob wildcards have no filesystem-path use here).",
    "  - Rejected literals: `all`, `unknown`, `tbd` (case-insensitive — these are placeholder strings, not real paths).",
    "  - Rejected forms: absolute paths (`/abs/...`), `..` parent-traversal segments.",
    "  - Permitted: framework dynamic-route segments are valid POSIX filenames and ARE allowed. Examples: `src/app/cases/[caseId]/page.tsx`, `src/app/docs/[...slug]/page.tsx`, `src/app/[[...slug]]/page.tsx`, `app/(public)/[lang]/page.tsx`, `pages/{group}/post.tsx`. Use the real on-disk file path; do NOT strip brackets/braces or substitute a different file.",
    "",
    "Use this shape:",
    "```json",
    EXECUTION_STRATEGY_JSON_EXAMPLE,
    "```",
  ].join("\n");
}

function formatFindingsForTranscript(findings: { findings: ReviewerVerdict["findings"] }): string {
  return [
    "## Findings",
    "### P0",
    ...formatFindingList(findings.findings.P0),
    "### P1",
    ...formatFindingList(findings.findings.P1),
    "### P2",
    ...formatFindingList(findings.findings.P2),
    "### P3",
    ...formatFindingList(findings.findings.P3),
  ].join("\n");
}

function formatFindingList(findings: string[]): string[] {
  return findings.length > 0 ? findings.map((finding) => `- ${finding}`) : ["- None."];
}

function extractExecutionStrategyJsonForTranscript(plan: string): unknown | undefined {
  const candidates: string[] = [];
  const sectionMatch = /^##\s+Execution Strategy\b/im.exec(plan);
  if (sectionMatch) {
    const section = plan.slice(sectionMatch.index);
    const nextSection = /^##\s+(?!Execution Strategy\b)/im.exec(section.slice(1));
    const sectionBody = nextSection ? section.slice(0, nextSection.index + 1) : section;
    candidates.push(...extractFencedJsonForTranscript(sectionBody));
  }
  candidates.push(...extractFencedJsonForTranscript(plan));
  const trimmed = plan.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning; transcripts should include the best parseable candidate.
    }
  }
  return undefined;
}

function extractFencedJsonForTranscript(text: string): string[] {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const body = match[1].trim();
    if (body.startsWith("{")) candidates.push(body);
  }
  return candidates;
}

function executionStrategyArtifactFromResolved(
  resolved: ReturnType<typeof validateExecutionStrategy>,
): ExecutionStrategy {
  return {
    version: 1,
    maxParallelMilestones: resolved.maxParallelMilestones,
    maxParallelStoriesPerMilestone: resolved.maxParallelStoriesPerMilestone,
    milestoneWaves: resolved.milestoneWaves.map((wave) => ({
      id: wave.id,
      milestones: wave.milestones,
      ...(wave.dependsOn.length > 0 ? { dependsOn: wave.dependsOn } : {}),
      maxParallel: wave.maxParallel,
    })),
    stories: Object.fromEntries(
      Object.entries(resolved.stories).map(([milestoneId, storyStrategy]) => [
        milestoneId,
        {
          maxParallelStories: storyStrategy.maxParallelStories,
          storyWaves: storyStrategy.storyWaves.map((wave) => ({
            id: wave.id,
            stories: wave.stories,
            ...(wave.dependsOn.length > 0 ? { dependsOn: wave.dependsOn } : {}),
            maxParallel: wave.maxParallel,
            writeSets: wave.writeSets,
          })),
        },
      ]),
    ),
  };
}

function composePromptForResearcher(input: SfTeamPlanInput): string {
  const parts: string[] = [`Title: ${input.title}`];
  if (input.brief && input.brief.trim().length > 0) {
    parts.push("");
    parts.push(`Brief: ${input.brief.trim()}`);
  }
  return parts.join("\n");
}

/**
 * Shared boilerplate carried in BOTH the initial planner brief and the
 * revision brief. The planner subprocess is spawned fresh (no-session)
 * for every call, so each prompt must independently carry the
 * structural requirements; otherwise a reviewer-requested revision
 * could regress to refusal-prose despite the initial brief being
 * correct.
 */
const PLANNER_FORMAT_REMINDER = [
  "Format reminders (apply to revisions too):",
  "  - Return the full markdown plan body in your final assistant response. Do NOT write `task-plan.md`, `milestone-plan.md`, `execution-strategy.json`, or any other plan files yourself.",
  "  - Do NOT return a summary-only response such as `Plan written to ...`; the orchestrator uses your final assistant response as the canonical plan text.",
  "  - Each milestone MUST have an `### M<N>: <Title>` heading, a `**Description:**` paragraph, an `**Acceptance Criteria:**` checklist, and a literal `**Stories:**` subsection with `- **S-N01 — Title.** Body.` bullets.",
  "  - Include a `## Execution Strategy` section with one fenced JSON object matching `execution-strategy.json`: `version`, bounded `maxParallelMilestones`, bounded `maxParallelStoriesPerMilestone`, `milestoneWaves`, and per-milestone `stories` waves.",
  "  - `milestoneWaves` MUST be an array of objects with `id` and `milestones`, never an array-of-arrays. Per-milestone `stories.<M>.storyWaves` MUST be an array of objects with `id`, `stories`, and `writeSets` when parallelism is claimed.",
  "  - For every story wave that schedules more than one story or has `maxParallel > 1`, include a concrete `writeSets` array for EVERY scheduled story. Use exact repo-relative file paths only.",
  "  - **writeSet path validator rules (deterministic — enforced before reviewer):**",
  "    * Rejected chars: `*`, `?` (shell-glob wildcards have no filesystem-path use here).",
  "    * Rejected literals: `all`, `unknown`, `tbd` (case-insensitive — these are placeholder strings, not real paths).",
  "    * Rejected forms: absolute paths (`/abs/...`), `..` parent-traversal segments.",
  "    * **Permitted: framework dynamic-route segments are valid POSIX filenames and ARE allowed.** Examples: `src/app/cases/[caseId]/page.tsx`, `src/app/docs/[...slug]/page.tsx`, `src/app/[[...slug]]/page.tsx`, `app/(public)/[lang]/page.tsx`, `pages/{group}/post.tsx`. Use the **real on-disk file path** the brief named; do NOT strip brackets/braces or substitute a different file.",
  "  - The Execution Strategy MUST call out which milestones and stories can run in parallel, dependency ordering via `dependsOn`, and repo-relative `writeSets` for dependency/file-scope safety. Do not mark work parallel when file ownership is unclear.",
  `  - If there is no safe parallelism, still emit the \`## Execution Strategy\` JSON for ${EXECUTION_STRATEGY_FILE} as an explicit sequential strategy.`,
  "  - The orchestrator's plan-shape validator REJECTS approved plans that fail length, milestone, or stories checks.",
  "",
  "Expected execution-strategy JSON shape:",
  "```json",
  EXECUTION_STRATEGY_JSON_EXAMPLE,
  "```",
  "",
  "LOCKFILE NOTE: Do NOT refuse to draft based on the presence of `.sf-team-locks/*.lock` or `.sf-team.lock` files in the workspace. The orchestrator that spawned you holds the lock; you should draft normally regardless of any lockfile sighting. A refusal-prose response (instead of a real plan) will be REJECTED by the orchestrator's structural validator and counted as a failed run.",
].join("\n");

function composePlannerBrief(title: string, enrichedBrief: string, tddMode: "on" | "off" | "auto" = "auto"): string {
  return [
    `Draft a milestone plan for: ${title}`,
    "",
    enrichedBrief.length > 0 ? enrichedBrief : "(no additional brief; use sensible defaults)",
    "",
    "Format: ## Goal, ## Architecture, ## Tech stack, ## Milestones, ## Risks.",
    "",
    PLANNER_FORMAT_REMINDER,
    PLANNER_TDD_REMINDER({ tddMode }),
  ].join("\n");
}

/**
 * Test-only re-export of internal helpers. Not part of the public API.
 * Used by `tests/planner-prompt-shape.test.ts` to assert the runtime
 * planner brief carries the lockfile + Stories-format clauses.
 */
export const __testing__ = {
  composeInitialPlanReviewPrompt,
  composePlannerBrief,
  composeReviseBrief: () => composeReviseBrief("prior plan body", { findings: { P0: ["sample"], P1: [], P2: [], P3: [] } }),
};

const EXPLICIT_RESEARCHER_SKIP_PHRASES = [
  "no research needed",
  "skip researcher",
  "use brief as-is",
];

/**
 * Build the synthetic researcher decision used when the caller supplied
 * `analysisOverride` (auto-chain or explicit pre-computed analysis path).
 */
function buildOverrideResearcherDecision(prompt: string, policy: ResearcherPolicy): ResearcherDecision {
  const refs = scanRefs(prompt);
  const signals = detectSelfContainedSignals(prompt);
  return {
    policy,
    action: "skipped",
    reason: "analysisOverride provided by caller",
    externalRefs: refs.length,
    signals: ["analysisOverride", ...signals],
  };
}

/**
 * Researcher decision wrapper that respects a successful Jira context fetch.
 *
 * - `policy="always"`: keep the existing decision (used). When Jira context
 *   was also fetched, append a parenthetical note to `reason` so transcripts
 *   show both signals.
 * - `policy="auto"` AND Jira context succeeded: skip the researcher because
 *   the Jira walker already provided ticket details. Bypasses the existing
 *   `scanRefs` / self-contained-signal branches.
 * - All other cases: delegate to the existing `decideResearcher`.
 */
function decideResearcherWithJira(
  prompt: string,
  policy: ResearcherPolicy,
  jiraContext: JiraContextResult | undefined,
): ResearcherDecision {
  const jiraUsed = jiraContext?.status === "used";
  if (policy === "auto" && jiraUsed) {
    const refs = scanRefs(prompt);
    const signals = detectSelfContainedSignals(prompt);
    return {
      policy,
      action: "skipped",
      reason: `Jira context provided ticket details (${jiraContext!.fetchedCount} key${
        jiraContext!.fetchedCount === 1 ? "" : "s"
      })`,
      externalRefs: refs.length,
      signals,
    };
  }
  const baseline = decideResearcher(prompt, policy);
  if (policy === "always" && jiraUsed) {
    return { ...baseline, reason: `${baseline.reason} (Jira context also fetched)` };
  }
  return baseline;
}

function contextMarkdownForResearcher(jiraContext: JiraContextResult | undefined): string | undefined {
  return jiraContext?.status === "used" && jiraContext.markdown.trim().length > 0
    ? jiraContext.markdown
    : undefined;
}

function omitJiraRefsCoveredByAtlassianContext(
  externalContext: ExternalFetchResult,
  jiraContext: JiraContextResult | undefined,
): ExternalFetchResult {
  if (jiraContext?.status !== "used") return externalContext;
  const coveredKeys = new Set(jiraContext.detectedKeys);
  const coveredFigma = linkedFigmaIdentitiesFromAtlassianContext(jiraContext.markdown);
  if (coveredKeys.size === 0 && coveredFigma.size === 0) return externalContext;
  return {
    resolved: externalContext.resolved.filter(
      (hit) => !isExternalRefCoveredByAtlassianContext(hit.ref, coveredKeys, coveredFigma),
    ),
    unresolved: externalContext.unresolved.filter(
      (miss) => !isExternalRefCoveredByAtlassianContext(miss.ref, coveredKeys, coveredFigma),
    ),
  };
}

function isExternalRefCoveredByAtlassianContext(
  ref: ExternalRef,
  coveredKeys: ReadonlySet<string>,
  coveredFigma: ReadonlySet<string>,
): boolean {
  if (ref.kind === "jira") return coveredKeys.has(ref.id);
  if (ref.kind !== "url") return false;
  const key = jiraKeyFromBrowseUrl(ref.id);
  if (key !== undefined && coveredKeys.has(key)) return true;
  const figmaIdentity = figmaIdentityFromUrl(ref.id);
  return figmaIdentity !== undefined && coveredFigma.has(figmaIdentity);
}

function linkedFigmaIdentitiesFromAtlassianContext(markdown: string): ReadonlySet<string> {
  const identities = new Set<string>();
  const linkedFigmaStart = markdown.search(/^## Linked Figma Context\b/m);
  if (linkedFigmaStart < 0) return identities;
  const linkedFigmaMarkdown = markdown.slice(linkedFigmaStart);
  for (const match of linkedFigmaMarkdown.matchAll(/^###\s+(https?:\/\/(?:www\.)?figma\.com\/\S+)\s*$/gim)) {
    const identity = figmaIdentityFromUrl(match[1]);
    if (identity) identities.add(identity);
  }
  return identities;
}

function figmaIdentityFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase().replace(/^www\./, "") !== "figma.com") return undefined;
    const [, fileKey] = parsed.pathname.split("/").filter(Boolean);
    if (!fileKey) return undefined;
    const nodeId = parsed.searchParams.get("node-id") ?? parsed.searchParams.get("node_id");
    return nodeId ? `${fileKey}:${nodeId.replace(/-/g, ":")}` : fileKey;
  } catch {
    return undefined;
  }
}

function decideResearcher(prompt: string, policy: ResearcherPolicy): ResearcherDecision {
  const refs = scanRefs(prompt);
  const signals = detectSelfContainedSignals(prompt);
  if (policy === "always") {
    return { policy, action: "used", reason: "policy=always", externalRefs: refs.length, signals };
  }
  if (policy === "never") {
    return { policy, action: "skipped", reason: "policy=never", externalRefs: refs.length, signals };
  }
  if (refs.length > 0) {
    const kinds = [...new Set(refs.map((ref) => ref.kind))].join(", ");
    return {
      policy,
      action: "used",
      reason: `external refs detected by scanRefs: ${kinds}`,
      externalRefs: refs.length,
      signals,
    };
  }
  if (signals.length > 0) {
    return {
      policy,
      action: "skipped",
      reason: `self-contained brief signal: ${signals.join(", ")}`,
      externalRefs: 0,
      signals,
    };
  }
  return {
    policy,
    action: "used",
    reason: "auto policy found no strong self-contained signal",
    externalRefs: 0,
    signals,
  };
}

function detectSelfContainedSignals(prompt: string): string[] {
  const signals: string[] = [];
  const lower = prompt.toLowerCase();
  for (const phrase of EXPLICIT_RESEARCHER_SKIP_PHRASES) {
    if (hasWholePhrase(lower, phrase)) signals.push(phrase);
  }
  if (/```/.test(prompt)) signals.push("code block");
  if (/acceptance\s+criteria\s*:/i.test(prompt) || /(^|\n)\s*-\s*\[[ xX]?\]\s+/.test(prompt)) {
    signals.push("acceptance criteria");
  }
  if (/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|toml|yaml|yml|sh|sql|go|rs|rb|java|kt|swift|cpp|hpp|c|h)\b/.test(prompt)) {
    signals.push("file path");
  }
  return [...new Set(signals)];
}

function hasWholePhrase(lower: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lower);
}

function mergeMember(defaults: TeamMember, override: TeamMember | undefined): TeamMember {
  if (!override) return defaults;
  return {
    ...defaults,
    ...override,
    role: defaults.role,
  };
}

function describeAgentSettings(
  members: Record<AgentRole, TeamMember>,
  sources: Record<AgentRole, EffectiveAgentSettings["source"]>,
): AgentSettingsDetails {
  return {
    planner: describeAgent(members.planner, sources.planner),
    reviewer: describeAgent(members.reviewer, sources.reviewer),
    developer: describeAgent(members.developer, sources.developer),
    researcher: describeAgent(members.researcher, sources.researcher),
  };
}

function settingSources(
  override: TeamMember | undefined,
  fallback: AgentSettingsSource,
): EffectiveAgentSettings["source"] {
  return {
    model: override?.model !== undefined ? "input" : fallback,
    thinking: override?.thinking !== undefined ? "input" : fallback,
    heartbeatMs: override?.heartbeatMs !== undefined ? "input" : fallback,
  };
}

function describeAgent(member: TeamMember, source: EffectiveAgentSettings["source"]): EffectiveAgentSettings {
  const defaults = member.role === "steering-decider"
    ? DEFAULT_CONFIG.agents.reviewer
    : DEFAULT_CONFIG.agents[member.role];
  return {
    model: member.model,
    thinking: member.thinking ?? defaults.thinking,
    heartbeatMs: member.heartbeatMs ?? defaults.heartbeatMs,
    source,
  };
}

async function runAgentWithSteeringDrain<T>(
  run: () => Promise<T>,
  steering: import("../orchestrator/run").OrchestratorBodyContext["steering"],
): Promise<T> {
  await steering.drain("before-agent-spawn");
  try {
    return await run();
  } finally {
    await steering.drain("agent-ended");
  }
}

function composeReviseBrief(
  priorPlan: string,
  v: { findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] } },
  tddMode: "on" | "off" | "auto" = "auto",
): string {
  return [
    "Revise the plan to address the reviewer findings below. Return the FULL revised plan, not a diff.",
    "",
    PLANNER_FORMAT_REMINDER,
    PLANNER_TDD_REMINDER({ tddMode }),
    "",
    "## Findings",
    "### P0",
    ...v.findings.P0.map((f) => `- ${f}`),
    "### P1",
    ...v.findings.P1.map((f) => `- ${f}`),
    "### P2",
    ...v.findings.P2.map((f) => `- ${f}`),
    "### P3",
    ...v.findings.P3.map((f) => `- ${f}`),
    "",
    "## Prior plan",
    priorPlan,
  ].join("\n");
}

/**
 * Build a starter story-tracker from the approved plan body.
 *
 * Detects milestones in three common shapes:
 *   - heading: `## M0: Title`, `### M1: Title`
 *   - numbered bullet: `- M0: Title` / `* M0 - Title` / `1. M0: Title`
 *   - bare ID line: `M0: Title` standing alone
 *
 * Returns one milestone block per detected ID with one placeholder
 * `S-N01` story. Falls back to a single M0 row when nothing is found.
 * IDs are deduplicated (first-occurrence wins).
 */
/** Extract milestone {id,title} pairs from an approved plan body. Shared
 * between deriveStoryTracker, composeContinuationRunbook, and composeFinalTranscript
 * so they all see the same milestone list. */
export function extractMilestones(plan: string): { id: string; title: string }[] {
  const detected: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  const recordCandidate = (id: string, title: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    detected.push({ id, title: title.trim() || id });
  };

  // Pattern 1: markdown heading
  const headingRegex = /^#{2,4}\s+(M\d+)(?:[:.\s]+(.+))?$/gm;
  for (const m of plan.matchAll(headingRegex)) {
    recordCandidate(m[1], m[2] ?? "");
  }
  // Pattern 2: bullet / numbered list under a `## Milestones` section (or anywhere)
  const bulletRegex = /^\s*(?:[-*+]|\d+\.)\s+(M\d+)\s*[:\-—]\s*(.+)$/gm;
  for (const m of plan.matchAll(bulletRegex)) {
    recordCandidate(m[1], m[2] ?? "");
  }
  // Pattern 3: bare-line ID
  const bareRegex = /^(M\d+)\s*[:\-—]\s*(.+)$/gm;
  for (const m of plan.matchAll(bareRegex)) {
    recordCandidate(m[1], m[2] ?? "");
  }

  const milestones = detected.length > 0 ? detected : [{ id: "M0", title: "Initial milestone" }];
  // Sort by numeric suffix so M0/M1/M2 come out in order.
  milestones.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return milestones;
}

/**
 * Parse the actual `**Stories:**` list under each milestone heading and
 * return one entry per (milestone, story). Falls back to a single
 * `S-N01` placeholder per milestone when no story bullets are detected
 * (e.g. an LLM produced a tracker-less plan).
 *
 * Format expected (matches `superpowers:writing-plans`):
 *
 *   ### M1: Title
 *   ...
 *   **Stories:**
 *   - **S-101 — Short title.** Long prose…
 *   - **S-102 — Another title.** …
 *
 * Each bullet's id is the first `S-…` token; the description is the prose
 * between the id-separator (`—`/`-`/`:`) and the close-bold marker (`**`),
 * with bold markers stripped — close-bold (NOT the first `.`) bounds the
 * title so file extensions like `.sh`/`.md` and version dots survive intact.
 * Falls back to first-period truncation only when no close-bold is present
 * (non-bold story formats). Lines without an `S-…` token are ignored, and
 * only bullets inside the `**Stories:**` subsection are considered — so
 * acceptance-criteria checklists that mention an S-id never trigger a
 * false story row.
 */
export function extractMilestonesAndStories(plan: string): {
  id: string;
  title: string;
  stories: { id: string; description: string }[];
}[] {
  const milestones = extractMilestones(plan);
  const byId = new Map<string, { id: string; title: string; stories: { id: string; description: string }[] }>();
  for (const m of milestones) byId.set(m.id, { ...m, stories: [] });

  // Walk the plan tracking the most-recent milestone heading AND whether
  // we're inside that milestone's stories subsection. Bullets outside the
  // stories block are ignored — that prevents acceptance-criteria
  // checkboxes that *mention* an S-id from creating phantom rows.
  // Three story-section markers are recognized: literal `**Stories:**`
  // (the planner-canonical form), `### Stories`, and `#### Stories`. The
  // H3/H4 forms exist because some plans use heading-style sections; the
  // planner system prompt teaches the canonical bold form, but plans
  // produced before that prompt landed use the heading style.
  const milestoneHeadingRe = /^#{2,4}\s+(M\d+)\b/;
  const storiesBoldHeaderRe = /^\s*\*\*Stories:\*\*\s*$/i;
  const storiesH3HeaderRe = /^###\s+Stories\b/i;
  const storiesH4HeaderRe = /^####\s+Stories\b/i;
  // Any other `**Foo:**` subsection header (Acceptance Criteria, etc.) ends
  // the Stories block — typical milestone-plan.md structure puts these on
  // their own line.
  const otherSubsectionRe = /^\s*\*\*[^*]+:\*\*\s*$/;
  const headingRe = /^#{1,6}\s+\S/;
  const bulletRe = /^\s*[-*+]\s+(.*)$/;
  let currentId: string | undefined;
  let inStories = false;
  for (const line of plan.split("\n")) {
    const h = line.match(milestoneHeadingRe);
    if (h) {
      currentId = byId.has(h[1]) ? h[1] : undefined;
      inStories = false;
      continue;
    }
    // Stories-section markers: bold form, H3, or H4. Check BEFORE the
    // generic heading test (which would otherwise end the block on `###`).
    if (storiesBoldHeaderRe.test(line) || storiesH3HeaderRe.test(line) || storiesH4HeaderRe.test(line)) {
      inStories = true;
      continue;
    }
    // Any other heading at any level OR a non-Stories subsection bold-marker
    // ends the Stories block.
    if (headingRe.test(line)) {
      inStories = false;
      continue;
    }
    if (otherSubsectionRe.test(line)) {
      inStories = false;
      continue;
    }
    if (!currentId || !inStories) continue;
    const bm = line.match(bulletRe);
    if (!bm) continue;
    const body = bm[1];
    // Defense in depth: skip task-list checkbox bullets even if they slipped
    // into the Stories block somehow.
    if (/^\[[ xX]\]/.test(body)) continue;
    const idMatch = body.match(/\b(S-[A-Za-z0-9]+)\b/);
    if (!idMatch) continue;
    const sid = idMatch[1];
    const milestone = byId.get(currentId)!;
    if (milestone.stories.some((s) => s.id === sid)) continue;
    const after = body.slice((idMatch.index ?? 0) + sid.length);
    // The planner format is `- **S-XXX — Title.** prose`. The title is
    // bounded by the close-bold marker (`**`), not the first period —
    // titles routinely contain `.sh` / `.md` / `verify:pi` etc., so we
    // can't truncate at the first `.`. When no close-bold is present
    // (non-bold format), fall back to the first period.
    const closeBoldIdx = after.indexOf("**");
    const titlePortion = closeBoldIdx >= 0
      ? after.slice(0, closeBoldIdx)
      : (() => {
          const periodIdx = after.indexOf(".");
          return periodIdx >= 0 ? after.slice(0, periodIdx) : after;
        })();
    let desc = titlePortion
      .replace(/^[\s*—\-:]*/, "") // strip leading separators / emphasis chars
      .replace(/\*\*/g, "") // drop any leftover bold markers
      .replace(/\.\s*$/, "") // strip a single trailing period (the one before close-bold)
      .trim();
    if (desc.length > 200) desc = `${desc.slice(0, 197)}...`;
    milestone.stories.push({ id: sid, description: desc.length > 0 ? desc : sid });
  }

  // Fallback: if a milestone produced no story rows, emit a single placeholder
  // so the tracker is still shaped correctly downstream. Uses the milestone
  // title as the description — preserves prior behavior for tracker-less plans.
  for (const m of byId.values()) {
    if (m.stories.length === 0) {
      const placeholderId = `S-${m.id.replace(/^M/, "")}01`;
      m.stories.push({ id: placeholderId, description: m.title });
    }
  }

  return milestones.map((m) => byId.get(m.id)!);
}

/**
 * Returns true iff at least one literal `M\d+` milestone marker is present
 * in the plan body (heading, bullet-list, or bare-line). The synthetic
 * `M0: Initial milestone` fallback that `extractMilestones` emits when
 * NOTHING is detected does NOT count.
 *
 * Used by `sf_team_plan` to reject planner output that produces no real
 * milestones (e.g. a refusal-prose response or a planner that drafted
 * structureless text).
 */
export function hasRealMilestones(plan: string): boolean {
  // Mirror the three patterns extractMilestones uses, but skip the
  // synthetic-fallback step so a "blank" plan returns false.
  if (/^#{2,4}\s+M\d+(?:[:.\s]+.+)?$/m.test(plan)) return true;
  if (/^\s*(?:[-*+]|\d+\.)\s+M\d+\s*[:\-—]\s*.+$/m.test(plan)) return true;
  if (/^M\d+\s*[:\-—]\s*.+$/m.test(plan)) return true;
  return false;
}

/**
 * Returns true iff at least one harvestable story bullet (one with an
 * `S-…` id) is present under any of the three recognized story-section
 * markers: literal `**Stories:**`, `### Stories`, or `#### Stories`,
 * AND that Stories block is under an `M\d+` milestone heading.
 *
 * The "under a milestone" requirement matches `extractMilestonesAndStories`,
 * which only harvests bullets when a current milestone is set. An orphan
 * Stories block at the top of a document with no milestone above it is
 * NOT enough — the validator must mirror the harvester so plans that pass
 * validation actually populate the tracker.
 *
 * The per-milestone synthetic placeholder rows that
 * `extractMilestonesAndStories` emits when a milestone has no real bullets
 * do NOT count — those are tracker-fallback metadata, not real stories.
 */
export function hasRealStories(plan: string): boolean {
  const milestoneHeadingRe = /^#{2,4}\s+M\d+\b/;
  const storiesBoldHeaderRe = /^\s*\*\*Stories:\*\*\s*$/i;
  const storiesH3HeaderRe = /^###\s+Stories\b/i;
  const storiesH4HeaderRe = /^####\s+Stories\b/i;
  const otherSubsectionRe = /^\s*\*\*[^*]+:\*\*\s*$/;
  const headingRe = /^#{1,6}\s+\S/;
  const bulletRe = /^\s*[-*+]\s+(.*)$/;

  let underMilestone = false;
  let inStories = false;
  for (const line of plan.split("\n")) {
    if (milestoneHeadingRe.test(line)) {
      underMilestone = true;
      inStories = false;
      continue;
    }
    if (storiesBoldHeaderRe.test(line) || storiesH3HeaderRe.test(line) || storiesH4HeaderRe.test(line)) {
      // Stories markers only count if we're currently under a milestone.
      // An orphan Stories block at the top of the doc is ignored.
      inStories = underMilestone;
      continue;
    }
    if (otherSubsectionRe.test(line)) {
      inStories = false;
      continue;
    }
    if (headingRe.test(line)) {
      // Any other heading ends a Stories block. Note: we keep
      // `underMilestone=true` because a milestone block can contain
      // multiple headings (e.g. `**Description:**` is bold-only, but a
      // future plan might use `### Subtask` inside a milestone) — the
      // milestone scope only ends when a NEW `M\d+` heading appears.
      inStories = false;
      continue;
    }
    if (!inStories) continue;
    const bm = line.match(bulletRe);
    if (!bm) continue;
    const body = bm[1];
    // Skip task-list checkboxes even if they slipped into the Stories block.
    if (/^\[[ xX]\]/.test(body)) continue;
    if (/\bS-[A-Za-z0-9]+\b/.test(body)) return true;
  }
  return false;
}

export function deriveStoryTracker(plan: string): string {
  const milestones = extractMilestonesAndStories(plan);

  const out: string[] = ["# Story Tracker\n", "## Milestones\n"];
  for (const m of milestones) {
    out.push(`### ${m.id}: ${sanitizeForMarkdown(m.title)}\n`);
    out.push("| Story | Description | Status | Notes |");
    out.push("|-------|-------------|--------|-------|");
    for (const s of m.stories) {
      out.push(`| ${s.id} | ${sanitizeForTableCell(s.description)} | pending | |`);
    }
    out.push("");
    out.push("**Approval Status:** pending\n");
  }
  return out.join("\n");
}

/**
 * Build a continuation runbook from facts the orchestrator already knows
 * (slug, title, milestone list, plan-review round count). Replaces the
 * old 3-line stub. Mirrors the structure of the reference runbook the
 * user authored by hand for `2026-05-01-sf-team`.
 */
export function composeContinuationRunbook(opts: {
  slug: string;
  title: string;
  milestones: { id: string; title: string }[];
  planReviewRounds: number;
  generatedAt?: Date;
}): string {
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
  // Normalize edge cases: empty milestones list → fall back to a single-M0
  // placeholder; control chars in title would reshape the markdown.
  const milestones = opts.milestones.length > 0 ? opts.milestones : [{ id: "M0", title: "Initial milestone" }];
  const milestoneArrow = milestones.map((m) => m.id).join(" → ");
  const milestoneCount = milestones.length;
  const safeTitle = sanitizeForMarkdown(opts.title);
  const lines: string[] = [];
  lines.push(`# Continuation Runbook: ${safeTitle}`);
  lines.push("");
  lines.push(`> Generated by \`sf_team_plan\` on ${generatedAt}; approved by reviewer after ${opts.planReviewRounds} round(s).`);
  lines.push("");
  lines.push("## Reference Files (START HERE)");
  lines.push("");
  lines.push("Upon resumption, these files in this folder are the ONLY source of truth:");
  lines.push("");
  lines.push("| File | Purpose | When to Use |");
  lines.push("|------|---------|-------------|");
  lines.push("| `continuation-runbook.md` | Full context reproduction + execution workflow | Read FIRST |");
  lines.push("| `execution-strategy.json` | Parallel milestone/story waves, dependencies, and file-scope safety metadata | Read before choosing work order |");
  lines.push("| `story-tracker.md` | Current progress and status | Check/update BEFORE and AFTER every story |");
  lines.push("| `milestone-plan.md` | Complete plan with specifications | Reference implementation details |");
  lines.push("| `original-plan.md` | Original approved plan (identical to milestone-plan.md at handoff) | Reference original intent |");
  lines.push("| `final-transcript.md` | Per-round planning audit log + approval summary | Reference reasoning/context |");
  lines.push("");
  lines.push("Do NOT reference planner-private files (under `transcript/`) during implementation — those are post-mortem only.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Quick Resume Instructions");
  lines.push("");
  lines.push("1. Read this runbook completely.");
  lines.push("2. Check `execution-strategy.json` for parallel waves and dependencies.");
  lines.push("3. Check `story-tracker.md`.");
  lines.push("4. Find next `pending` story and mark as `in-dev` before starting.");
  lines.push("5. Implement the story.");
  lines.push("6. Update tracker immediately after each change.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Mandatory Execution Workflow");
  lines.push("");
  lines.push(`Work from this folder (\`ai_plan/${opts.slug}/\`) and always follow this order:`);
  lines.push("");
  lines.push("1. Read `continuation-runbook.md` first.");
  lines.push("2. Read `execution-strategy.json`; use its milestone/story waves for safe parallel execution. If it is missing in an old plan folder, use the implement tool's sequential fallback.");
  if (milestoneCount > 1) {
    lines.push(`3. Execute milestones according to the strategy; without parallel waves, use order: ${milestoneArrow}.`);
  } else {
    lines.push(`3. Execute the single milestone: ${milestones[0].id}.`);
  }
  lines.push("4. After completing a milestone:");
  lines.push("   - Run `pnpm typecheck` and `pnpm test` (prioritize changed files for speed).");
  lines.push("   - Commit locally (**DO NOT PUSH**).");
  lines.push("   - Stop and ask user for feedback.");
  lines.push("5. If feedback is provided:");
  lines.push("   - Apply feedback changes.");
  lines.push("   - Re-run checks for changed files.");
  lines.push("   - Commit locally again.");
  lines.push("   - Ask for milestone approval.");
  lines.push("6. Only move to next milestone wave after explicit approval.");
  lines.push(`7. After all ${milestoneCount} milestone(s) are completed and approved:`);
  lines.push("   - Ask permission to push.");
  lines.push("   - If approved, push.");
  lines.push("   - Mark plan status as `completed`.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Git Note");
  lines.push("");
  lines.push("`ai_plan/` is gitignored. Updates to files in this folder DO NOT need to be committed and the inability to commit them is NOT an error. The per-milestone commits in step 3 of the workflow are for the SOURCE-CODE changes the developer makes — not for files inside `ai_plan/`.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Tracker Discipline (MANDATORY)");
  lines.push("");
  lines.push("ALWAYS update `story-tracker.md` BEFORE/AFTER each story transition. NEVER proceed without the tracker up to date.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Verification Gate (per milestone)");
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm typecheck");
  lines.push("pnpm test");
  lines.push("```");
  lines.push("");
  lines.push("All must pass before commit.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Milestones");
  lines.push("");
  for (const m of milestones) {
    lines.push(`- **${m.id}**: ${sanitizeForMarkdown(m.title)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Sanitize a string for safe inclusion in markdown headings / list items.
 * Newlines, carriage returns, and other control characters are collapsed
 * to spaces so they can't reshape the document.
 */
function sanitizeForMarkdown(s: string): string {
  return s.replace(/[\r\n\t\v\f]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Same as sanitizeForMarkdown plus pipe-encoding so the value is safe to
 * place inside a markdown table cell. We use the HTML entity `&#124;`
 * rather than the markdown escape `\|` because `parseTrackerText` (and
 * any other naive `.split("|")` consumer) treats the backslash as
 * literal and still splits on the pipe character, corrupting the row.
 * The entity renders as `|` in markdown viewers AND survives the split.
 */
function sanitizeForTableCell(s: string): string {
  return sanitizeForMarkdown(s).replace(/\|/g, "&#124;");
}

/**
 * Build a final transcript file summarizing the planning loop. Pointers
 * to the per-round transcript folder for full audit detail.
 */
export function composeFinalTranscript(opts: {
  slug: string;
  title: string;
  milestones: { id: string; title: string }[];
  planReviewRounds: number;
  generatedAt?: Date;
}): string {
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
  const milestones = opts.milestones.length > 0 ? opts.milestones : [{ id: "M0", title: "Initial milestone" }];
  const lines: string[] = [];
  lines.push(`# Final Transcript: ${sanitizeForMarkdown(opts.title)}`);
  lines.push("");
  lines.push(`Generated ${generatedAt}.`);
  lines.push("");
  lines.push("## Plan-review summary");
  lines.push("");
  lines.push(`- Plan-review rounds used: **${opts.planReviewRounds}**`);
  lines.push(`- Milestones detected: **${milestones.length}**`);
  lines.push(`- Order: ${milestones.map((m) => m.id).join(" → ")}`);
  lines.push(`- Execution strategy artifact: \`${EXECUTION_STRATEGY_FILE}\``);
  lines.push("- Execution strategy includes milestone/story waves, dependencies, and write-set safety metadata; old folders without it use a sequential fallback.");
  lines.push("");
  lines.push("## Per-round audit log");
  lines.push("");
  lines.push("Every agent handoff (researcher analysis, planner draft, reviewer verdicts, planner revisions, P3-only fixup) is preserved as a separate file under:");
  lines.push("");
  lines.push("```");
  lines.push(`ai_plan/${opts.slug}/transcript/`);
  lines.push("```");
  lines.push("");
  lines.push("Each file is named `NNNN-<role>-<label>[-round-N][-STATUS].md` and contains the role's full output, status, and severity counts. Read them in numeric order to walk the loop chronologically.");
  lines.push("");
  return lines.join("\n");
}

/**
 * If `brief` is empty or trivially short and we have a UI context, prompt
 * the user once for a brief and once for constraints. Concatenate into a
 * single brief string. Returns the original brief if no UI is present
 * (headless mode falls back to the existing sparse-brief behavior).
 */
async function maybeAskForBrief(
  brief: string | undefined,
  ctx: { ui?: ExtensionUIContext; signal?: AbortSignal },
): Promise<string | undefined> {
  const trimmed = (brief ?? "").trim();
  if (trimmed.length >= 8) return brief;
  if (!ctx.ui) return brief;
  const askUser = new AskUser(ctx.ui);
  const briefAnswer = await askUser.input({
    key: "sf_team_plan.brief",
    title: "What should this plan accomplish?",
    placeholder: "Short description of the goal",
    signal: ctx.signal,
  });
  const constraintsAnswer = await askUser.input({
    key: "sf_team_plan.constraints",
    title: "Constraints (optional)",
    placeholder: "Tech stack, deadlines, must-haves — leave blank to skip",
    signal: ctx.signal,
  });
  const parts: string[] = [];
  if (trimmed.length > 0) parts.push(trimmed);
  if (briefAnswer && briefAnswer.trim().length > 0) parts.push(briefAnswer.trim());
  if (constraintsAnswer && constraintsAnswer.trim().length > 0) {
    parts.push(`Constraints: ${constraintsAnswer.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : brief;
}

function defaultPlanner(agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents): TeamMember {
  const d = agents.planner;
  return {
    role: "planner",
    model: d.model,
    thinking: d.thinking,
    heartbeatMs: d.heartbeatMs,
  };
}

function defaultReviewer(agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents): TeamMember {
  const d = agents.reviewer;
  return { role: "reviewer", model: d.model, thinking: d.thinking, heartbeatMs: d.heartbeatMs };
}

function defaultResearcher(agents: ResolvedDefaults["agents"] = DEFAULT_CONFIG.agents): TeamMember {
  const d = agents.researcher;
  // Researcher gets no skills — its argv profile pins read-only tools and the
  // task brief tells it exactly what JSON to emit. Skills would just slow it.
  return { role: "researcher", model: d.model, thinking: d.thinking, heartbeatMs: d.heartbeatMs };
}
