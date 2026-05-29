import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowReporter,
  runWorkflow,
  type LockMetadata,
  type WorkflowCheckpointRuntime,
  type WorkflowToolName,
  type WorkflowReporter,
  type VerificationRunCache,
} from "@pi-stef/agent-workflows";

import { captureBaseline, loadBaseline, type Baseline } from "../plan/baseline";
import { planFolderPath, planFolderPathFromRoot, PLAN_FOLDER_ROOT } from "../plan/paths"; // migration-allowed: legacy
import path from "node:path";
import { mountWidget, type WidgetHandle } from "../tui/dispose";
import { mountCostFooter, type CostFooterHandle } from "../tui/cost-footer";
import { applyAgentEvent } from "../tui/wiring";
import { clearAgents, emptyState, setMessages, upsertAgent, type AgentState, type WidgetState } from "../tui/state";
import type { AgentEvent, AgentRun, TeamMember } from "../runtime/types";
import { agentStateFromTerminalEvent, eventAffectsWidget, isTerminalAgentEvent } from "../runtime/events";
import { writeDiagnostics } from "./diagnostics";
import { promptForResume, type ResumePromptResult } from "./resume";
import { createTranscriptFromFolder, type TranscriptHandle } from "./transcript";
import { writePerformanceReport, type RecordedAgentRun } from "./performance";
import {
  composeCostSummary,
  emptyUsageTotal,
  readHistoricalCostSummary,
  usageFromAgentUsage,
  type CostSummary,
  type CostUsageTotal,
} from "./cost";
import { notifyTelegram, type TelegramOptions } from "../notify/telegram";
import { getActiveSession, isValidLauncherSessionName, TmuxManager, type PaneLayoutRole } from "../tmux/manager";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../config/schema";
import type { WorkflowProfile } from "../config/schema";
import {
  createActiveWorkflowRegistry,
  workflowKindFromToolName,
  createWorkflowRunId,
  resolvePlanSteeringRoot,
  createSteeringOrchestratorContext,
  type SteeringOrchestratorContext,
  reconcileSteeringResume,
  createSteeringStore,
  PausedSteeringError,
} from "../steering";

export interface RunOrchestratorContext {
  /** Repo root (parent for ai_plan/ and the worktree base). */
  repoRoot: string;
  /** Plan slug (folder name under ai_plan/). Required for lock + diagnostics + baseline. */
  slug: string;
  /** Tool name for lock metadata + diagnostics + telegram message. */
  toolName: WorkflowToolName;
  /** Durable resume owner. Defaults to `toolName`; `sf_team_auto` sets this for nested plan/implement phases. */
  ownerTool?: WorkflowToolName;
  /** Allowed prior owners for normal handoff flows that intentionally claim an existing plan folder. */
  allowOwnerTakeoverFrom?: WorkflowToolName[];
  /**
   * Slug of the parent plan when this run derives from one (followups).
   * Forwarded into the workflow metadata so resume paths can rehydrate
   * parent context. Optional; stand-alone runs leave it undefined.
   */
  parentSlug?: string;
  /** AbortSignal forwarded into the tool body. */
  signal?: AbortSignal;
  /** UI context (when interactive). */
  ui?: ExtensionUIContext;
  /** When the developer edits the user's current working tree (no worktree), capture baseline. */
  useWorktree: boolean;
  /**
   * Resolved parent directory for plan folders. Defaults to `<repoRoot>/ai_plan` when omitted.
   * Passed down into the lock path and baseline helpers.
   */
  planRoot?: string;
  /**
   * Git policy for this run. Defaults to `'on'` when omitted (preserves existing behavior).
   * When `'off'`, baseline capture and all git operations are skipped.
   */
  gitMode?: "on" | "off";
  /** TDD policy for this run. Defaults to `'auto'` when omitted. */
  tddMode?: "on" | "off" | "auto";
  /** Telegram opts (default disabled). */
  telegram?: TelegramOptions;
  /** Optional widget handle override (for tests / dependency injection). */
  widget?: WidgetHandle;
  /** Minimum interval for coalescing non-terminal widget updates. Defaults to config performance.widget_update_interval_ms. */
  widgetUpdateIntervalMs?: number;
  /**
   * Optional tmux pane manager (M6 wiring). When set (or auto-detected
   * via `getActiveSession()`), every spawned agent gets a tail-F'ing
   * pane in the right side-split of the active tmux session.
   *
   * Pass `null` to explicitly disable auto-detection (regression tests
   * that exercise the no-tmux path). Omit to let the orchestrator
   * decide based on `getActiveSession()`.
   */
  tmuxManager?: TmuxManager | null;
  /**
   * Test-only: explicit tmux session name to use when `tmuxManager` is
   * also injected. Production code never sets this — it's resolved via
   * `getActiveSession()`. Tests inject a stub manager + a deterministic
   * session name so the wiring doesn't depend on an actual `$TMUX`
   * environment.
   */
  tmuxSessionName?: string;
  /**
   * Optional pre-resolved session alias (e.g. `sf_team_auto-1`). When
   * set, the orchestrator skips `nextSessionAlias(toolName)` and uses
   * this value instead. `sf_team_auto` uses this so the wrapping run
   * AND its inner plan/implement runs all decorate the SAME tmux
   * session. When omitted, the orchestrator computes the alias from
   * `toolName`.
   */
  tmuxSessionAliasOverride?: string;
  /** Tracked agent runs at error time — populated by the body via `ctx.recordRun`. */
  workflowProfile?: WorkflowProfile;
  /** True when this invocation is resuming a previously-started workflow folder. */
  resumeMode?: boolean;
  reviewRoundLimits?: {
    maxRounds?: number;
    planMaxRounds?: number;
    implementationMaxRounds?: number;
  };
}

export interface OrchestratorBodyContext {
  resume: ResumePromptResult;
  baseline?: Baseline;
  lock: LockMetadata;
  widget: WidgetHandle | undefined;
  /** Short-lived operational status lane. UI mode renders in the widget; headless mode writes stderr. */
  reporter: WorkflowReporter;
  checkpoints: WorkflowCheckpointRuntime;
  /** Per-orchestrator-run verification cache. Shared by before/after gates and repeated milestone/story checks. */
  verificationCache: VerificationRunCache;
  /** Persistent verification cache path under ai_plan/<slug>/.pi/sf/agent-workflows/. Used only when verification.cache=persistent. */
  verificationCachePath: string;
  /**
   * Per-run transcript helper. Tools call `transcript.record({...})` after
   * each agent handoff so the user can audit a long planner↔reviewer loop
   * after the fact. Files land under
   * `ai_plan/<slug>/transcript/<phase>/` where `<phase>` is `planning` or
   * `implementation`; tools call `transcript.setPhase("implementation")`
   * at their own boundary site (`task.ts` before the developer spawn,
   * `implement.ts` at body entry, `plan.ts` never). Per-phase counters
   * resume safely from existing files (`max+1`).
   */
  transcript: TranscriptHandle;
  /**
   * Forwarded from `RunOrchestratorContext.signal`. Tool bodies pass this
   * into spawnAgent, askUser, runReviewLoop, etc. so abort propagates
   * through the entire stack.
   */
  signal: AbortSignal | undefined;
  /** Track an AgentRun so diagnostics/reports can include it. */
  recordRun(run: AgentRun, member?: TeamMember, agentId?: string, spawnKey?: string): void;
  /** Durable steering control-plane API for mid-workflow user instructions. */
  steering: SteeringOrchestratorContext;
  /**
   * Register an agent for live TUI rendering. Returns an `onEvent` listener
   * that the spawn helper threads into `spawnAgent` so every protocol event
   * updates the widget state. Calling `subscribeAgent` BEFORE the spawn
   * upserts a card in `running` state immediately so the panel shows the
   * agent before any output arrives.
   *
   * `opts.milestoneId` and `opts.storyId` are rendered in the card's head
   * line (e.g. "· M1 - S101") so the widget tells the user which lane an
   * agent is working on without exposing the internal card id.
   */
  subscribeAgent(
    member: TeamMember,
    agentId?: string,
    opts?: {
      milestoneId?: string;
      storyId?: string;
      paneGroupId?: string;
      paneLayoutRole?: PaneLayoutRole;
    },
  ): { agentId: string; spawnKey: string; onEvent: (e: AgentEvent) => void; rawLogPath?: string };
  /**
   * Drop every agent card from the widget. Use at milestone boundaries
   * (and at the plan→implement phase boundary in `sf_team_auto`) so the
   * panel shows only the agents currently in flight. Milestone progress,
   * resume banner, and lock state are preserved.
   */
  clearAgents(): void;
}

export type OrchestratorBody<T> = (ctx: OrchestratorBodyContext) => Promise<T>;

export interface OrchestratorResult<T> {
  result: T;
  /** Set when the resume prompt returned `false` and the orchestrator short-circuited. */
  declinedResume?: boolean;
  /** Success-path timing artifact under `ai_plan/<slug>/`, when it could be written. */
  performanceReportPath?: string;
  costSummary?: CostSummary;
}

/**
 * Wrap a tool body in the standard orchestrator scaffolding:
 *
 *   1. resume prompt (M9 S-906 + M6 detectResumeState)
 *   2. acquire per-folder lock (M6 S-608)
 *   3. mount the TUI widget (M8 mountWidget)
 *   4. capture baseline iff !useWorktree (M9 S-911)
 *   5. run body
 *   6. finally: dispose widget, release lock, fire telegram, write diagnostics on error
 *
 * Errors propagate. Diagnostics are still written before the error reaches
 * the caller. Telegram is best-effort.
 */
export async function runOrchestrator<T>(
  ctx: RunOrchestratorContext,
  body: OrchestratorBody<T>,
): Promise<OrchestratorResult<T>> {
  const startedAtMs = Date.now();
  const steeringWorkflowKind = workflowKindFromToolName(ctx.toolName);
  const steeringWorkflowId = steeringWorkflowKind ? createWorkflowRunId(steeringWorkflowKind) : undefined;
  const widgetUpdateIntervalMs = Math.max(
    0,
    ctx.widgetUpdateIntervalMs ?? DEFAULT_CONFIG.performance.widget_update_interval_ms,
  );
  let widget: WidgetHandle | undefined;
  let costFooter: CostFooterHandle | undefined;
  let widgetState: WidgetState = emptyState();
  let pendingWidgetUpdate: NodeJS.Timeout | undefined;
  let pendingElapsedWidgetUpdate: NodeJS.Timeout | undefined;
  let pendingSteeringTick: NodeJS.Timeout | undefined;
  let steeringContext: SteeringOrchestratorContext | undefined;
  const hasRunningAgents = (): boolean => widgetState.agents.some((agent) => agent.state === "running");
  const clearElapsedWidgetUpdate = (): void => {
    if (!pendingElapsedWidgetUpdate) return;
    clearTimeout(pendingElapsedWidgetUpdate);
    pendingElapsedWidgetUpdate = undefined;
  };
  const scheduleElapsedWidgetUpdate = (): void => {
    if (!widget || pendingElapsedWidgetUpdate || !hasRunningAgents()) return;
    pendingElapsedWidgetUpdate = setTimeout(() => {
      pendingElapsedWidgetUpdate = undefined;
      if (!widget || !hasRunningAgents()) return;
      widget.update(widgetState);
      scheduleElapsedWidgetUpdate();
    }, 1_000);
    pendingElapsedWidgetUpdate.unref?.();
  };
  const maintainElapsedWidgetUpdate = (): void => {
    if (hasRunningAgents()) scheduleElapsedWidgetUpdate();
    else clearElapsedWidgetUpdate();
    maintainSteeringTick();
  };
  const clearSteeringTick = (): void => {
    if (!pendingSteeringTick) return;
    clearInterval(pendingSteeringTick);
    pendingSteeringTick = undefined;
  };
  const maintainSteeringTick = (): void => {
    if (!steeringContext || !hasRunningAgents()) {
      clearSteeringTick();
      return;
    }
    if (pendingSteeringTick) return;
    pendingSteeringTick = setInterval(() => {
      if (!steeringContext || !hasRunningAgents()) {
        clearSteeringTick();
        return;
      }
      void steeringContext.drain("child-active-tick");
    }, DEFAULT_CONFIG.steering.child_active_tick_ms);
    pendingSteeringTick.unref?.();
  };
  const renderWidgetNow = (): void => {
    if (pendingWidgetUpdate) {
      clearTimeout(pendingWidgetUpdate);
      pendingWidgetUpdate = undefined;
    }
    widget?.update(widgetState);
  };
  const scheduleWidgetUpdate = (): void => {
    if (!widget) return;
    if (widgetUpdateIntervalMs <= 0) {
      renderWidgetNow();
      return;
    }
    if (pendingWidgetUpdate) return;
    pendingWidgetUpdate = setTimeout(() => {
      pendingWidgetUpdate = undefined;
      widget?.update(widgetState);
    }, widgetUpdateIntervalMs);
    pendingWidgetUpdate.unref?.();
  };
  const agentRuns: RecordedAgentRun[] = [];
  const ownerTool = ctx.ownerTool ?? ctx.toolName;
  const priorCost = (ctx.resumeMode || (ctx.ownerTool !== undefined && ctx.ownerTool !== ctx.toolName))
    ? await readHistoricalCostSummary(ctx.repoRoot, ctx.slug, {
      logicalToolName: ownerTool,
      ownerTool,
      includeLegacyAutoReports: ownerTool === "sf_team_auto",
    })
    : { usage: emptyUsageTotal(), reportCount: 0 };
  const settledUsageBySpawn = new Map<string, CostUsageTotal>();
  const inFlightUsageBySpawn = new Map<string, CostUsageTotal>();
  const authoritativeSpawnKeys = new Set<string>();
  let spawnIndex = 0;
  let syntheticIndex = 0;
  const getCostSummary = (): CostSummary =>
    composeCostSummary(priorCost, settledUsageBySpawn, inFlightUsageBySpawn);
  const updateFooter = (): void => {
    costFooter?.update();
  };

  // 3b) tmux pane manager auto-detection. Honor an explicit injection
  //     (including `null` to disable for the no-tmux regression test);
  //     otherwise instantiate the real manager iff getActiveSession()
  //     returns non-null.
  let tmuxManager: TmuxManager | undefined;
  let tmuxSessionName: string | undefined;
  let tmuxLauncherSession = false; // true when the session was launcher-emitted
  const tmuxRunId = randomUUID();
  // Per-role pane index counters so titles show `researcher-1`,
  // `developer-M1` (milestone-aware when the caller passes one), etc.
  const paneIndexByRole = new Map<string, number>();
  if (ctx.tmuxManager === null) {
    // Explicitly disabled (regression tests).
    tmuxManager = undefined;
  } else if (ctx.tmuxManager) {
    // Explicit injection (tests). Use the explicit session name when
    // provided; otherwise default to a fixed test-friendly name so the
    // wiring path is exercised regardless of `$TMUX`.
    tmuxManager = ctx.tmuxManager;
    tmuxSessionName = ctx.tmuxSessionName ?? "sf-team-default";
    tmuxLauncherSession = isValidLauncherSessionName(tmuxSessionName);
  } else {
    // Production auto-detect via getActiveSession().
    const active = getActiveSession();
    if (active) {
      tmuxManager = new TmuxManager();
      tmuxSessionName = active.sessionName;
      tmuxLauncherSession = active.isLauncherSession;
    }
  }
  // Session decoration runs once on first subscribe. Launcher-emitted
  // sessions are renamed to `<toolName>-<N>`; regular user tmux sessions
  // are never renamed, but still get sticky pane headers (`[Main]`,
  // `[planner-1]`, etc.) for sf_team_* runs.
  let sessionPrepared = false;
  const prepareSessionOnce = (): void => {
    if (!tmuxManager || !tmuxSessionName || sessionPrepared) return;
    sessionPrepared = true;
    try {
      if (tmuxLauncherSession) {
        // The caller (e.g. sf_team_auto wrapping plan + implement) can
        // force a shared alias so all nested orchestrator runs land on
        // the SAME session. Otherwise we compute a fresh `<toolName>-N`.
        const alias = ctx.tmuxSessionAliasOverride ?? tmuxManager.nextSessionAlias(ctx.toolName);
        const r = tmuxManager.prepareSession({ sessionName: tmuxSessionName, sessionAlias: alias });
        // The session may have been renamed; track the new name for
        // subsequent openAgentPane calls.
        tmuxSessionName = r.sessionName;
      } else {
        tmuxManager.decorateSession({ sessionName: tmuxSessionName });
      }
    } catch {
      // tmux decoration failed — disable subsequent pane ops so we
      // don't surface partial state.
      tmuxManager = undefined;
    }
  };

  /**
   * Compute the pane title for an agent. Format `<role>-<index>` where
   * index is per-role (researcher-1, developer-M1 for milestone-bound
   * developers, etc). Independent of the WIDGET title (which uses
   * `renderAgentCardTitle`); the user sees pane titles in tmux's
   * pane-border-status, and widget titles inside the main pane.
   */
  const paneTitleForAgent = (role: string, milestoneId: string | undefined, storyId: string | undefined): string => {
    if (milestoneId && storyId) {
      const safeStoryId = storyId.replace(/[^A-Za-z0-9]/g, "");
      return `${role}-${milestoneId}-${safeStoryId}`;
    }
    if (milestoneId) {
      return `${role}-${milestoneId}`;
    }
    const next = (paneIndexByRole.get(role) ?? 0) + 1;
    paneIndexByRole.set(role, next);
    return `${role}-${next}`;
  };
  // Generation map: each (id, round) is a distinct subscription. A late
  // event from an abandoned round (e.g. round 1's `agent_end` arriving
  // after round 2 already started) MUST NOT mutate round 2's card. We
  // capture the round at subscribe-time and ignore events whose
  // captured round no longer matches the card's current round.
  const isTerminalState = (s: AgentState): boolean =>
    s === "completed" || s === "failed" || s === "aborted" || s === "stalled";
  const subscribeAgent: OrchestratorBodyContext["subscribeAgent"] = (member, agentId, opts) => {
    const id = agentId ?? member.role;
    spawnIndex += 1;
    const spawnKey = `${id}#${spawnIndex}`;
    const existing = widgetState.agents.find((a) => a.id === id);
    const myRound = existing ? (existing.round ?? 1) + 1 : 1;
    widgetState = upsertAgent(widgetState, {
      id,
      role: member.role,
      model: member.model,
      state: "running",
      startedAtMs: Date.now(),
      // Reset the terminal stamp + activity from the previous round so the
      // re-used card reads as a fresh `▶ running` instead of carrying over
      // the old `✓ completed` glyph + frozen timer.
      endedAtMs: undefined,
      activity: undefined,
      round: myRound,
      milestoneId: opts?.milestoneId,
      storyId: opts?.storyId,
    });
    renderWidgetNow();
    scheduleElapsedWidgetUpdate();

    // tmux pane: open on subscribe so the user sees an empty pane
    // (titled "<role>-<index>") immediately, then the agent's
    // pretty-piped log streams human-readable output as it runs.
    let agentRawLogPath: string | undefined;
    let agentPaneId: string | undefined;
    if (tmuxManager && tmuxSessionName) {
      // Decorate the session on the FIRST subscribe (rename + main
      // pane title + pane-border-status). Idempotent.
      prepareSessionOnce();
      // prepareSessionOnce may have disabled the manager on failure.
      if (tmuxManager && tmuxSessionName) {
        try {
          const paneTitle = paneTitleForAgent(member.role, opts?.milestoneId, opts?.storyId);
          const r = tmuxManager.openAgentPane({
            sessionName: tmuxSessionName,
            agentId: id,
            paneTitle,
            runId: tmuxRunId,
            groupId: opts?.paneLayoutRole ? (opts?.paneGroupId ?? opts?.milestoneId) : opts?.paneGroupId,
            parentGroupId: opts?.paneLayoutRole === "story" ? (opts?.paneGroupId ?? opts?.milestoneId) : undefined,
            layoutRole: opts?.paneLayoutRole,
            storyId: opts?.storyId,
          });
          agentRawLogPath = r.logPath;
          agentPaneId = r.paneId;
        } catch {
          // Failure to open a pane MUST NOT break the run — the agent
          // still spawns, just without a tmux mirror.
        }
      }
    }
    const onEvent = (e: AgentEvent): void => {
      const card = widgetState.agents.find((a) => a.id === id);
      const isLiveRound = !!card && (card.round ?? 1) === myRound;

      if (e.kind === "usage") {
        updateUsageFromEvent(spawnKey, e.usage);
      }

      // Pane lifecycle (this subscription's own pane) MUST close even
      // when the round guard fires — otherwise a superseded
      // subscription's terminal event leaks the old pane until final
      // teardown. The `agentPaneId` captured in this closure is unique
      // to THIS subscription, so closing it here cannot interfere with
      // a newer subscription's pane.
      if (agentPaneId && tmuxManager) {
        const stateFromEvent = agentStateFromTerminalEvent(e);
        if (stateFromEvent && isTerminalState(stateFromEvent)) {
          settleInFlightUsage(spawnKey);
          try { tmuxManager.closeAgentPane(agentPaneId); } catch { /* swallow */ }
          agentPaneId = undefined;
        }
      }
      if (!agentPaneId && isTerminalAgentEvent(e)) {
        settleInFlightUsage(spawnKey);
      }

      // Widget mutation only happens for the LIVE round — otherwise a
      // late event from an abandoned earlier round would freeze the
      // current round's card with the old run's terminal state.
      if (!isLiveRound) return;
      if (!eventAffectsWidget(e)) return;
      const nextWidgetState = applyAgentEvent(widgetState, id, e);
      if (Object.is(nextWidgetState, widgetState)) return;
      widgetState = nextWidgetState;
      if (isTerminalAgentEvent(e)) renderWidgetNow();
      else scheduleWidgetUpdate();
      maintainElapsedWidgetUpdate();
    };
    return { agentId: id, spawnKey, onEvent, rawLogPath: agentRawLogPath };
  };
  const clearAgentsFn: OrchestratorBodyContext["clearAgents"] = () => {
    // Close every pane belonging to a card that's about to be dropped
    // BEFORE the state mutation — so the manager has a chance to look
    // up paneIds via tracked agentIds.
    if (tmuxManager) {
      for (const card of widgetState.agents) {
        try { tmuxManager.closeAgentPane(card.id); } catch { /* swallow */ }
      }
    }
    widgetState = clearAgents(widgetState);
    clearElapsedWidgetUpdate();
    renderWidgetNow();
  };
  const effectivePlanFolder = ctx.planRoot
    ? planFolderPathFromRoot(ctx.planRoot, ctx.slug)
    : planFolderPath(ctx.repoRoot, ctx.slug); // migration-allowed: legacy
  const workflow = await runWorkflow<T, Baseline, { performanceReportPath?: string }>(
    {
      repoRoot: ctx.repoRoot,
      slug: ctx.slug,
      toolName: ctx.toolName,
      ownerTool: ctx.ownerTool,
      allowOwnerTakeoverFrom: ctx.allowOwnerTakeoverFrom,
      parentSlug: ctx.parentSlug,
      useWorktree: ctx.useWorktree,
      signal: ctx.signal,
      resumeMode: ctx.resumeMode,
      planRoot: ctx.planRoot,
      gitMode: ctx.gitMode,
      tddMode: ctx.tddMode,
      promptForResume: (repoRoot, slug) => promptForResume(repoRoot, slug, ctx.ui),
      onLockHeld(error): void {
        // Surface lock contention as a friendly error; never write diagnostics
        // here because we have NO lock to claim the diagnostics file.
        ctx.ui?.notify?.(`sf-team: ${error.message}`, "error");
      },
      createReporter() {
        widget = ctx.widget ?? (ctx.ui ? mountWidget(ctx.ui) : undefined);
        costFooter = ctx.ui ? mountCostFooter(ctx.ui, getCostSummary) : undefined;
        const reporter = createWorkflowReporter({
          getMessages: () => widgetState.messages,
          setMessages: (messages) => {
            widgetState = setMessages(widgetState, messages);
          },
          render: renderWidgetNow,
          headless: !widget,
        });
        // Initial render so the panel APPEARS as soon as the orchestrator
        // starts — before this, mountWidget only created a handle.
        renderWidgetNow();
        updateFooter();
        return reporter;
      },
      async resolveBaseline() {
        // Centralized baseline-capture (S-911): when use_worktree=false the
        // developer edits the user's current tree, so we snapshot HEAD +
        // porcelain before any developer-impl phase. Resume/worktree paths
        // surface a previously captured baseline when one exists.
        const planRoot = ctx.planRoot ?? path.join(ctx.repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
        const gitMode = ctx.gitMode ?? "on";
        if (gitMode === "off") return undefined;
        return ctx.useWorktree
          ? loadBaseline(planRoot, ctx.slug)
          : captureBaseline(planRoot, ctx.slug, { repoRoot: ctx.repoRoot });
      },
      async onSuccess(_workflowCtx, _result) {
        const performanceReportPath = await writePerformanceReport(ctx.repoRoot, {
          slug: ctx.slug,
          toolName: ctx.toolName,
          ownerTool: ctx.ownerTool ?? ctx.toolName,
          status: "completed",
          workflowProfile: ctx.workflowProfile,
          reviewRoundLimits: ctx.reviewRoundLimits,
          startedAtMs,
          finishedAtMs: Date.now(),
          agentRuns,
          costSummary: getCostSummary(),
        }, { planFolder: effectivePlanFolder });
        return { performanceReportPath };
      },
      async onError(_workflowCtx, err) {
        const performanceReportPath = await writePerformanceReport(ctx.repoRoot, {
          slug: ctx.slug,
          toolName: ctx.toolName,
          ownerTool: ctx.ownerTool ?? ctx.toolName,
          status: "failed",
          workflowProfile: ctx.workflowProfile,
          reviewRoundLimits: ctx.reviewRoundLimits,
          startedAtMs,
          finishedAtMs: Date.now(),
          agentRuns,
          costSummary: getCostSummary(),
          error: err,
        }, { planFolder: effectivePlanFolder }).catch(() => undefined);
        await writeDiagnostics(ctx.repoRoot, {
          slug: ctx.slug,
          toolName: ctx.toolName,
          agentRuns: agentRuns.map((entry) => entry.run),
          notes: [
            ctx.signal?.aborted ? "aborted via signal" : undefined,
            performanceReportPath ? `performance report: ${performanceReportPath}` : undefined,
          ].filter((note): note is string => !!note).join("\n") || undefined,
          error: err,
        }).catch(() => undefined);
      },
      beforeReporterDispose() {
        // Teardown order mirrors the pre-migration orchestrator: tmux panes
        // first, widget timers, reporter, widget, lock release, telegram.
        if (tmuxManager) {
          try {
            tmuxManager.closeAllPanes(tmuxSessionName);
          } catch {
            // ignore
          }
        }
        if (pendingWidgetUpdate) {
          clearTimeout(pendingWidgetUpdate);
          pendingWidgetUpdate = undefined;
        }
        clearElapsedWidgetUpdate();
        clearSteeringTick();
        try {
          costFooter?.dispose();
        } catch {
          // ignore
        }
      },
      afterReporterDispose() {
        try {
          widget?.dispose();
        } catch {
          // ignore
        }
      },
      afterLockRelease(_workflowCtx, error) {
        if (!ctx.telegram?.enabled) return;
        const status = error ? `failed (${describeError(error)})` : "completed";
        try {
          notifyTelegram(`${ctx.toolName} ${ctx.slug}: ${status}`, ctx.telegram);
        } catch {
          // ignore — telegram never blocks
        }
      },
    },
    async (workflowCtx) => {
      const transcript = createTranscriptFromFolder(effectivePlanFolder);
      const planRoot = effectivePlanFolder;
      const steeringRoot = resolvePlanSteeringRoot(planRoot);
      const steeringStore = createSteeringStore({ rootDir: steeringRoot, expectedRoot: planRoot });
      await reconcileSteeringResume(steeringStore);
      // Steering uses a STABLE workflow id across resumes so that guidance
      // rows persisted in `guidance.jsonl` continue to match the workflow
      // filter on the resume run. `steeringWorkflowId` (a fresh UUID per
      // process invocation) is used for the active-workflow registry only.
      const stableSteeringWorkflowId = `${ctx.toolName}:${ctx.slug}`;
      const steering = createSteeringOrchestratorContext({
        workflowId: stableSteeringWorkflowId,
        workflowKind: steeringWorkflowKind ?? "task",
        store: steeringStore,
        repoRoot: ctx.repoRoot,
        planFolderPath: planRoot,
        reporter: workflowCtx.reporter,
        transcript,
        confirmDestructiveAction: ctx.ui
          ? async (summary) => await ctx.ui?.confirm(
            "Discard active-agent changes?",
            summary.confirmationMessage,
            { signal: ctx.signal },
          ) === true
          : undefined,
      });
      steeringContext = steering;
      const bodyCtx: OrchestratorBodyContext = {
        resume: workflowCtx.resume as ResumePromptResult,
        lock: workflowCtx.lock,
        widget,
        reporter: workflowCtx.reporter,
        checkpoints: workflowCtx.checkpoints,
        verificationCache: workflowCtx.verificationCache,
        verificationCachePath: workflowCtx.verificationCachePath,
        baseline: workflowCtx.baseline,
        signal: ctx.signal,
        recordRun(run, member, agentId, spawnKey): void {
          agentRuns.push({ run, member, agentId });
          const key = spawnKey ?? `${agentId ?? member?.role ?? "agent"}#synthetic-${++syntheticIndex}`;
          const usage = usageFromAgentUsage(run.usage);
          if (usage) {
            inFlightUsageBySpawn.delete(key);
            settledUsageBySpawn.set(key, usage);
            authoritativeSpawnKeys.add(key);
            updateFooter();
          }
        },
        subscribeAgent,
        clearAgents: clearAgentsFn,
        transcript,
        steering,
      };
      if (!steeringWorkflowKind || !steeringWorkflowId) return body(bodyCtx);

      const registry = createActiveWorkflowRegistry(ctx.planRoot ?? ctx.repoRoot);
      await registry.register({
        workflowId: steeringWorkflowId,
        workflowKind: steeringWorkflowKind,
        planSlug: ctx.slug,
        repoRoot: ctx.repoRoot,
        steeringRoot,
      });
      try {
        const bodyResult = await body(bodyCtx);
        // Workflow completed normally: expire all workflow-scoped guidance
        // for this run so a subsequent workflow does not inherit stale
        // injection text. Milestone- and story-scoped rows are already
        // expired by tools/implement.ts at their respective boundaries.
        // M4 will introduce the third "paused-steering" branch that
        // preserves guidance across resume.
        await steeringStore
          .expireGuidanceForScope("workflow", stableSteeringWorkflowId)
          .catch(() => undefined);
        return bodyResult;
      } catch (workflowErr) {
        // PausedSteeringError is the third workflow-exit branch: preserve
        // workflow-scoped guidance + pauseState in state.json so the next
        // resume reads the latch and either prompts (UI available) or
        // rethrows. Don't expire any guidance here.
        if (workflowErr instanceof PausedSteeringError) {
          throw workflowErr;
        }
        // Other aborts: same as completion — workflow-scoped guidance
        // expires.
        await steeringStore
          .expireGuidanceForScope("workflow", stableSteeringWorkflowId)
          .catch(() => undefined);
        throw workflowErr;
      } finally {
        await registry.unregister(steeringWorkflowId).catch(() => undefined);
      }
    },
  );

  return {
    result: workflow.result,
    declinedResume: workflow.declinedResume,
    performanceReportPath: workflow.artifacts?.performanceReportPath,
    costSummary: getCostSummary(),
  };

  function updateUsageFromEvent(spawnKey: string, usage: AgentRun["usage"]): void {
    if (!usage || authoritativeSpawnKeys.has(spawnKey)) return;
    const converted = usageFromAgentUsage(usage);
    if (!converted) return;
    const settled = settledUsageBySpawn.get(spawnKey);
    if (settled) {
      if (converted.totalTokens >= settled.totalTokens) {
        settledUsageBySpawn.set(spawnKey, converted);
        updateFooter();
      }
      return;
    }
    inFlightUsageBySpawn.set(spawnKey, converted);
    updateFooter();
  }

  function settleInFlightUsage(spawnKey: string): void {
    const usage = inFlightUsageBySpawn.get(spawnKey);
    if (!usage) return;
    inFlightUsageBySpawn.delete(spawnKey);
    settledUsageBySpawn.set(spawnKey, usage);
    updateFooter();
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
