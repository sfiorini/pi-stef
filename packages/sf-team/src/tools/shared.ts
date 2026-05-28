import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowCheckpointRuntime, WorkflowReporter } from "@pi-stef/agent-workflows";

import { parseReviewerVerdict, type ReviewerVerdict } from "../review/parse";
import { MaxReviewRoundsError, ReviewerEmptyVerdictError, RevisionUnchangedError, isEmptyReviewerOutput, runReviewLoop, type ReviewerFn, type ReviewerPriorContext, type ReviseFn, type RunReviewLoopOptions } from "../review/loop";
import { truncateBytes } from "./impl-summary";
import { PLAN_FOLDER_ROOT, planFolderPathFromRoot } from "../plan/paths";
import { fetchJiraContext as defaultFetchJiraContext } from "../research/jira-context";
import { spawnAgent as defaultSpawnAgent } from "../runtime/spawn";
import { agentStateFromTerminalEvent } from "../runtime/events";
import type { AgentEvent, AgentRun, AgentTask, TeamMember } from "../runtime/types";
import { combineAbortSignals, composeRestartPrompt } from "../steering/agent-control";
import {
  loadActiveSteeringGuidance,
  prependSteeringGuidanceSection,
  type GuidanceInjectionFilter,
} from "../steering/guidance-inject";
import type { SteeringStore } from "../steering/store";
import type { ActiveAgentRecord, ActiveAgentState, RunningAgentControl } from "../steering/types";
import type { PaneLayoutRole } from "../tmux/manager";

export interface ToolDeps {
  spawnAgent: typeof defaultSpawnAgent;
  runReviewLoop: typeof runReviewLoop;
  fetchJiraContext: typeof defaultFetchJiraContext;
}

export const defaultDeps: ToolDeps = {
  spawnAgent: defaultSpawnAgent,
  runReviewLoop,
  fetchJiraContext: defaultFetchJiraContext,
};

export interface SpawnAgentReturning {
  /**
   * Spawn an agent.
   *
   * `widgetAgentId` (optional) overrides the orchestrator's default
   * one-card-per-role behavior. Tools that run the same role multiple
   * times CONCURRENTLY (e.g. sf_team_implement's per-milestone developer)
   * pass an explicit id like `developer-M3` so each milestone gets its
   * own card instead of stomping the role-default card.
   *
   * `opts.milestoneId` (optional) is rendered in the card's head line
   * (e.g. "· M1") so the widget tells the user which milestone an agent
   * is working on.
   */
  spawn(
    member: TeamMember,
    task: AgentTask,
    widgetAgentId?: string,
    opts?: {
      milestoneId?: string;
      storyId?: string;
      paneGroupId?: string;
      paneLayoutRole?: PaneLayoutRole;
      registerActiveAgent?: boolean;
      expectedWriteScope?: string[];
    },
  ): Promise<AgentRun>;
  /** Asserts the run completed (not aborted/stalled/failed); returns finalText. */
  spawnText(
    member: TeamMember,
    task: AgentTask,
    errorPrefix: string,
    widgetAgentId?: string,
    opts?: {
      milestoneId?: string;
      storyId?: string;
      paneGroupId?: string;
      paneLayoutRole?: PaneLayoutRole;
      registerActiveAgent?: boolean;
      expectedWriteScope?: string[];
    },
  ): Promise<string>;
}

/**
 * Typed steering injection context passed to the spawn helper. Carries the
 * durable steering store + workflow context so the helper can call
 * `loadActiveSteeringGuidance` for non-decider agents and prepend the
 * `## Active Steering Guidance` section before the centralized secret scan
 * runs in `runtime/spawn.ts`. The runtime-layer spawn is NOT modified;
 * injection lives entirely at the helper layer.
 */
export interface SteeringInjectionContext {
  store: SteeringStore;
  workflowId: string;
  agentRecord: { role: string; milestoneId?: string; storyId?: string };
  reporter?: WorkflowReporter;
}

interface SpawnSteeringContext {
  workflowId: string;
  registerAgent(record: ActiveAgentRecord, control: RunningAgentControl): Promise<void>;
  updateAgent(id: string, patch: Partial<ActiveAgentRecord>): Promise<void>;
  unregisterAgent(id: string, finalState: ActiveAgentState): Promise<void>;
  /** When set, the spawn helper auto-injects active steering guidance into non-decider prompts. */
  store?: SteeringStore;
  reporter?: WorkflowReporter;
}

interface SpawnHelperOptions {
  milestoneId?: string;
  storyId?: string;
  paneGroupId?: string;
  paneLayoutRole?: PaneLayoutRole;
  registerActiveAgent?: boolean;
  expectedWriteScope?: string[];
}

interface SpawnSubscription {
  agentId: string;
  spawnKey?: string;
  onEvent: (e: AgentEvent) => void;
  rawLogPath?: string;
}

interface SpawnHelperRuntimeOptions {
  recordRun?: (run: AgentRun, member?: TeamMember, agentId?: string, spawnKey?: string) => void;
  checkpoints?: WorkflowCheckpointRuntime;
  subscribeAgent?: (
    member: TeamMember,
    agentId?: string,
    opts?: {
      milestoneId?: string;
      storyId?: string;
      paneGroupId?: string;
      paneLayoutRole?: PaneLayoutRole;
    },
  ) => SpawnSubscription;
  steering?: SpawnSteeringContext;
}

/**
 * Build the spawn helper with optional `recordRun` callback so the
 * orchestrator's diagnostics can include the actual stderr/events from each
 * agent run. Tools pass `bodyCtx.recordRun` here so a stalled or failed run
 * surfaces with full context in `ai_plan/<slug>/diagnostics-<ts>.log`.
 *
 * When `subscribeAgent` is provided, every spawn registers a TUI agent card
 * BEFORE the child process forks, so the widget shows a `running` card
 * immediately. Each protocol event the child emits is fed through the
 * subscriber so the card's state / activity / transcript update live.
 */
export function makeSpawnHelper(
  deps: ToolDeps,
  opts: SpawnHelperRuntimeOptions = {},
): SpawnAgentReturning {
  const record = opts.recordRun ?? (() => undefined);
  const checkpointOrdinalByBase = new Map<string, number>();
  const nextCheckpointStepId = (member: TeamMember, widgetAgentId: string | undefined): string => {
    const base = `spawnText:${safeStepIdPart(widgetAgentId ?? member.role)}`;
    const next = (checkpointOrdinalByBase.get(base) ?? 0) + 1;
    checkpointOrdinalByBase.set(base, next);
    return `${base}:${next}`;
  };
  const runSpawnText = async (
    member: TeamMember,
    task: AgentTask,
    errorPrefix: string,
    widgetAgentId: string | undefined,
    spawnOpts: SpawnHelperOptions | undefined,
  ): Promise<string> => {
    const { run, agentId, spawnKey } = await runControlledSpawn(deps, opts, member, task, widgetAgentId, spawnOpts);
    record(run, member, agentId, spawnKey);
    if (run.state !== "completed") {
      throw new Error(`${errorPrefix}: ${run.state}${run.reason ? ` (${run.reason})` : ""}`);
    }
    return run.finalText;
  };
  return {
    async spawn(member, task, widgetAgentId, spawnOpts) {
      const { run, agentId, spawnKey } = await runControlledSpawn(deps, opts, member, task, widgetAgentId, spawnOpts);
      record(run, member, agentId, spawnKey);
      return run;
    },
    async spawnText(member, task, errorPrefix, widgetAgentId, spawnOpts) {
      if (!opts.checkpoints) {
        return runSpawnText(member, task, errorPrefix, widgetAgentId, spawnOpts);
      }
      const stepId = nextCheckpointStepId(member, widgetAgentId);
      return opts.checkpoints.runTextStep(
        stepId,
        { role: member.role, model: member.model, task: task.task, cwd: task.cwd },
        () => runSpawnText(member, task, errorPrefix, widgetAgentId, spawnOpts),
      );
    },
  };
}

async function runControlledSpawn(
  deps: ToolDeps,
  opts: SpawnHelperRuntimeOptions,
  member: TeamMember,
  originalTask: AgentTask,
  widgetAgentId: string | undefined,
  spawnOpts: SpawnHelperOptions | undefined,
): Promise<{ run: AgentRun; agentId: string; spawnKey?: string }> {
  let task = originalTask;
  let restartAttempt = 0;
  let lastAgentId = widgetAgentId ?? member.role;
  let lastSpawnKey: string | undefined;

  while (true) {
    // Helper-layer steering injection: prepend the "## Active Steering
    // Guidance" section to the prompt BEFORE the centralized secret scanner
    // runs in runtime/spawn.ts. The decider spawn opts out via
    // registerActiveAgent: false, mirroring the existing
    // SpawnSteeringContext-skip convention. promptHash / promptSummary on
    // the active-agent record are computed from the post-injection prompt
    // below so the durable record reflects the actually-sent text.
    if (
      opts.steering?.store
      && member.role !== "steering-decider"
      && spawnOpts?.registerActiveAgent !== false
    ) {
      const filter: GuidanceInjectionFilter = {
        workflowId: opts.steering.workflowId,
        role: member.role,
        milestoneId: spawnOpts?.milestoneId,
        storyId: spawnOpts?.storyId,
      };
      const guidance = await loadActiveSteeringGuidance(
        opts.steering.store,
        filter,
        { reporter: opts.steering.reporter },
      );
      if (guidance.lines.length > 0) {
        task = {
          ...task,
          task: prependSteeringGuidanceSection(task.task, guidance.lines),
        };
      }
    }
    const sub = spawnOpts?.registerActiveAgent === false
      ? undefined
      : opts.subscribeAgent?.(member, widgetAgentId, spawnOpts);
    const agentId = sub?.agentId ?? widgetAgentId ?? `${member.role}-${randomUUID()}`;
    const spawnKey = sub?.spawnKey;
    lastAgentId = agentId;
    lastSpawnKey = spawnKey;

    const agentAbort = new AbortController();
    let restartRequested: string | undefined;
    let resolveRunSettled!: () => void;
    const runSettled = new Promise<void>((resolve) => {
      resolveRunSettled = resolve;
    });
    let currentRecord = createActiveAgentRecord({
      agentId,
      member,
      task,
      workflowId: opts.steering?.workflowId,
      milestoneId: spawnOpts?.milestoneId,
      storyId: spawnOpts?.storyId,
      expectedWriteScope: spawnOpts?.expectedWriteScope,
    });
    const control: RunningAgentControl = {
      async abort(reason: string): Promise<void> {
        const patch: Partial<ActiveAgentRecord> = {
          state: "aborting",
          lastEventAt: new Date().toISOString(),
        };
        currentRecord = { ...currentRecord, ...patch };
        await opts.steering?.updateAgent(agentId, patch);
        if (!agentAbort.signal.aborted) agentAbort.abort(reason);
      },
      async restart(amendedPromptContext: string): Promise<void> {
        restartRequested = amendedPromptContext;
        const patch: Partial<ActiveAgentRecord> = {
          state: "aborting",
          lastEventAt: new Date().toISOString(),
        };
        currentRecord = { ...currentRecord, ...patch };
        await opts.steering?.updateAgent(agentId, patch);
        if (!agentAbort.signal.aborted) agentAbort.abort("Restart requested by sf-team steering.");
      },
      async waitForExit(): Promise<void> {
        await runSettled;
      },
      describe(): ActiveAgentRecord {
        return currentRecord;
      },
    };

    if (opts.steering && spawnOpts?.registerActiveAgent !== false) {
      await opts.steering.registerAgent(currentRecord, control);
    }

    const onEvent = (event: AgentEvent): void => {
      sub?.onEvent(event);
      if (!opts.steering || spawnOpts?.registerActiveAgent === false) return;
      const patch: Partial<ActiveAgentRecord> = { lastEventAt: new Date().toISOString() };
      const terminalState = activeStateFromEvent(event);
      if (terminalState) patch.state = terminalState;
      currentRecord = { ...currentRecord, ...patch };
      void opts.steering.updateAgent(agentId, patch).catch(() => undefined);
    };

    let run: AgentRun;
    try {
      run = await deps.spawnAgent(
        member,
        {
          ...task,
          signal: combineAbortSignals([task.signal, agentAbort.signal]),
        },
        {
          onEvent,
          rawLogPath: sub?.rawLogPath,
          onSpawn: (info) => {
            if (!opts.steering || spawnOpts?.registerActiveAgent === false) return;
            const patch: Partial<ActiveAgentRecord> = {
              pid: info.pid,
              state: "running",
              lastEventAt: new Date(info.startedAtMs).toISOString(),
            };
            currentRecord = { ...currentRecord, ...patch };
            void opts.steering.updateAgent(agentId, patch).catch(() => undefined);
          },
        },
      );
    } catch (err) {
      if (opts.steering && spawnOpts?.registerActiveAgent !== false) {
        await opts.steering.unregisterAgent(agentId, "failed").catch(() => undefined);
      }
      resolveRunSettled();
      throw err;
    }
    resolveRunSettled();

    const finalState = activeStateFromRun(run);
    currentRecord = {
      ...currentRecord,
      state: finalState,
      pid: run.pid,
      lastEventAt: new Date().toISOString(),
    };
    if (opts.steering && spawnOpts?.registerActiveAgent !== false) {
      await opts.steering.updateAgent(agentId, { pid: run.pid, lastEventAt: currentRecord.lastEventAt });
      await opts.steering.unregisterAgent(agentId, finalState);
    }

    if (restartRequested) {
      restartAttempt += 1;
      task = {
        ...originalTask,
        task: composeRestartPrompt({
          originalTaskSummary: summarizePrompt(originalTask.task),
          originalTask: originalTask.task,
          steeringInstruction: restartRequested,
          priorPartialStatus: summarizeRunForRestart(run, restartAttempt),
        }),
      };
      continue;
    }

    return { run, agentId: lastAgentId, spawnKey: lastSpawnKey };
  }
}

function safeStepIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function createActiveAgentRecord(input: {
  agentId: string;
  member: TeamMember;
  task: AgentTask;
  workflowId?: string;
  milestoneId?: string;
  storyId?: string;
  expectedWriteScope?: string[];
}): ActiveAgentRecord {
  const promptSummary = summarizePrompt(input.task.task);
  return {
    id: input.agentId,
    role: input.member.role,
    label: labelForAgent(input.member.role, input.milestoneId, input.storyId),
    workflowId: input.workflowId ?? "unknown-workflow",
    milestoneId: input.milestoneId,
    storyId: input.storyId,
    worktreePath: input.task.cwd ? path.resolve(input.task.cwd) : undefined,
    startedAt: new Date().toISOString(),
    state: "running",
    promptSummary,
    promptHash: createHash("sha256").update(input.task.task).digest("hex"),
    expectedWriteScope: input.expectedWriteScope,
  };
}

function activeStateFromEvent(event: AgentEvent): ActiveAgentState | undefined {
  const terminal = agentStateFromTerminalEvent(event);
  if (terminal === "completed") return "completed";
  if (terminal === "aborted") return "aborted";
  if (terminal === "failed" || terminal === "stalled") return "failed";
  return undefined;
}

function activeStateFromRun(run: AgentRun): ActiveAgentState {
  if (run.state === "completed") return "completed";
  if (run.state === "aborted" || run.state === "stalled") return "aborted";
  return "failed";
}

function summarizePrompt(prompt: string): string {
  return truncateBytes(prompt.replace(/\s+/g, " ").trim(), 500);
}

function summarizeRunForRestart(run: AgentRun, attempt: number): string {
  const details = [
    `Restart attempt ${attempt}; prior run ended as ${run.state}${run.reason ? ` (${run.reason})` : ""}.`,
    run.finalText ? `Partial final text: ${truncateBytes(run.finalText.replace(/\s+/g, " ").trim(), 800)}` : undefined,
    run.stderrTail ? `Stderr tail: ${truncateBytes(run.stderrTail.replace(/\s+/g, " ").trim(), 800)}` : undefined,
  ].filter((line): line is string => !!line);
  return details.join("\n");
}

function labelForAgent(role: string, milestoneId: string | undefined, storyId: string | undefined): string {
  if (milestoneId && storyId) return `${role} ${milestoneId} ${storyId}`;
  if (milestoneId) return `${role} ${milestoneId}`;
  return role;
}

/**
 * Verdict template injected into every reviewer prompt. We centralize it
 * here because individual tool prompts have historically been too vague
 * ("return the standard verdict structure") — opus-class models then
 * produce richer free-form output (`### Required revisions`,
 * `## Verdict: **Approve with minor revisions**`, etc.) that our parser
 * can't recognize. With the template inline we get strict-shape compliance
 * most of the time; the parser's fuzzy fallback (parse.ts:parseFuzzyVerdict)
 * is the safety net for when the model still drifts.
 */
export const REVIEWER_VERDICT_TEMPLATE = [
  "Return your review using EXACTLY this structure — verbatim section",
  "headers, no paraphrasing, no extra sections, no omitting empty severities:",
  "",
  "## Summary",
  "<one or two short sentences>",
  "",
  "## Findings",
  "### P0",
  "- <total blocker> (or `- None.` if no P0 findings)",
  "### P1",
  "- <major risk> (or `- None.`)",
  "### P2",
  "- <must-fix before approval> (or `- None.`)",
  "### P3",
  "- <cosmetic / nice-to-have> (or `- None.`)",
  "",
  "## Verdict",
  "VERDICT: APPROVED   (only when P0, P1, AND P2 are all `- None.`; P3 is non-blocking)",
  "or",
  "VERDICT: REVISE     (otherwise)",
  "",
  "DO NOT use phrases like \"Approve with minor revisions\" — that maps to",
  "VERDICT: REVISE in our system. Use the literal `VERDICT: APPROVED` or",
  "`VERDICT: REVISE` line. A required-revisions section of any kind belongs",
  "under ### P2.",
].join("\n");

export const EXECUTION_STRATEGY_JSON_EXAMPLE = [
  "{",
  '  "version": 1,',
  '  "maxParallelMilestones": 2,',
  '  "maxParallelStoriesPerMilestone": 2,',
  '  "milestoneWaves": [',
  '    { "id": "W1", "milestones": ["M1"], "maxParallel": 1 },',
  '    { "id": "W2", "milestones": ["M2", "M3"], "dependsOn": ["W1"], "maxParallel": 2 }',
  "  ],",
  '  "stories": {',
  '    "M2": {',
  '      "maxParallelStories": 2,',
  '      "storyWaves": [',
  '        {',
  '          "id": "M2-W1",',
  '          "stories": ["S-201", "S-202"],',
  '          "maxParallel": 2,',
  '          "writeSets": {',
  '            "S-201": ["repo/relative/file-a.ts"],',
  '            "S-202": ["repo/relative/file-b.ts"]',
  "          }",
  "        }",
  "      ]",
  "    }",
  "  }",
  "}",
].join("\n");

export const PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE = [
  "Execution Strategy review requirements:",
  "  - If the plan contains `## Execution Strategy` or an `execution-strategy.json` JSON object, verify that milestone and story ids are known, dependencies are ordered and acyclic, parallel caps are bounded, and repo-relative `writeSets` support dependency/file-scope safety.",
  "  - Treat unknown ids, duplicate scheduled ids, cycles, unbounded/invalid parallelism, missing or unsafe writeSets for parallel work, and unclear parallel file ownership as P2 findings.",
  "  - A fully sequential strategy is acceptable when the plan makes no safe parallelism claim; do not require parallelism for its own sake.",
  "  - `milestoneWaves` MUST be an array of objects with `id` and `milestones`; do not accept array-of-arrays such as `[[\"M1\"], [\"M2\"]]`.",
  "  - Per-milestone `stories.<M>.storyWaves` MUST be arrays of objects with `id`, `stories`, and repo-relative `writeSets` when parallelism is claimed.",
  "Expected execution-strategy JSON shape:",
  "```json",
  EXECUTION_STRATEGY_JSON_EXAMPLE,
  "```",
].join("\n");

/**
 * Wrap an arbitrary string-payload reviewer call in the `runReviewLoop`
 * shape — converts the reviewer's text into a parsed verdict on the fly.
 *
 * `taskFor` is the per-call instruction. It now receives the optional
 * `prior` context the loop tracks — undefined on round 1 (full fresh
 * review), populated on round 2+ so the call site can compose a
 * "verify-fixes" prompt that scopes the reviewer to (a) checking
 * whether the previous findings are addressed and (b) flagging
 * regressions the revision introduced. Composing those round-2+
 * prompts is what {@link composeVerifyFixesPrompt} is for.
 *
 * The verdict template is appended to whatever `taskFor` returns so
 * every reviewer spawn — round 1 or N — emits the exact same
 * `## Findings` + `## Verdict` shape; that shape is what feeds the
 * NEXT round's `prior`.
 */
export function makeReviewer(
  spawnText: SpawnAgentReturning["spawnText"],
  member: TeamMember,
  taskFor: (payload: string, prior?: ReviewerPriorContext<string>) => string,
  errorPrefix: string,
  widgetAgentId?: string,
  widgetOpts?: {
    milestoneId?: string;
    storyId?: string;
    paneGroupId?: string;
    paneLayoutRole?: PaneLayoutRole;
  },
  /**
   * Optional working directory passed to the reviewer subprocess via
   * `AgentTask.cwd`. When set (the impl-review path uses `ctx.cwd`,
   * the worktree), the reviewer's `read,grep,find,ls` tools resolve
   * relative paths inside the worktree so the reviewer can spot-check
   * specific files referenced by the developer's summary. The plan-review
   * path leaves it undefined; the reviewer there has no diff to inspect.
   */
  taskCwd?: string,
): ReviewerFn<string> {
  return async (payload, prior, signal) => {
    // taskFor is invoked exactly once per loop round — composes the prompt
    // (including round-2+ verify-fixes scoping). The retry below is a
    // SUBPROCESS retry, not a fresh prompt round, so the same task body
    // is reused.
    const taskBody = `${taskFor(payload, prior)}\n\n${REVIEWER_VERDICT_TEMPLATE}`;
    const taskObj = { task: taskBody, signal, ...(taskCwd ? { cwd: taskCwd } : {}) };
    let text = await spawnText(member, taskObj, errorPrefix, widgetAgentId, widgetOpts);
    // One-shot retry on whitespace-only output. This was the M3 failure
    // mode: the reviewer subprocess completed but emitted no assistant
    // text, the parsed verdict was UNKNOWN with empty findings, the loop
    // called revise with no actionable input, and the developer reproduced
    // the prior payload bytes — surfacing as the confusing
    // RevisionUnchangedError. Retrying here recovers from transient
    // model/subprocess flakes; persistent emptiness is then caught by
    // `runReviewLoop` and surfaced as `ReviewerEmptyVerdictError`.
    if (isEmptyReviewerOutput(text)) {
      text = await spawnText(member, taskObj, errorPrefix, widgetAgentId, widgetOpts);
    }
    return { verdictText: text, verdict: parseReviewerVerdict(text) };
  };
}

/**
 * Hard byte cap applied to plan-reviewer payloads (the planner's full plan
 * markdown). 128 KB is generous enough that any realistic plan fits whole
 * (the largest plans observed in practice run ~30-50 KB). The cap exists
 * as a structural defense: a runaway plan that somehow ballooned past the
 * cap would still be safely transmitted to the reviewer, with the
 * truncation marker pointing the reviewer at the planner's transcript so
 * it can read the full body via its `read,grep,find,ls` tools (the plan
 * reviewers now also receive `cwd: ctx.repoRoot`, so relative paths
 * resolve in the user's working tree).
 *
 * Note: the round-2+ verify-fixes prompt embeds BOTH the round-1 original
 * plan AND the current revised plan. Worst case is therefore ~256 KB of
 * plan text plus the prior verdict (8 KB) plus structural overhead — well
 * under macOS ARG_MAX (~1 MB) but tight enough that a 256 KB plan body
 * is the genuine red line. If a project ever hits that regularly, the
 * answer is structural plan splitting, not a higher cap.
 */
export const PLAN_PAYLOAD_CAP_BYTES = 131_072;

/**
 * Cap byte length on a plan-reviewer payload (the full plan markdown,
 * unchanged otherwise). On overflow append a marker line pointing at the
 * planner's transcript folder + telling the reviewer it can read the full
 * body via its read tool (cwd is the worktree). The transcript hint is a
 * partial label (e.g. `planner-draft`); transcripts are written to
 * `<repoRoot>/ai_plan/<slug>/transcript/NNNN-<role>-<label>.md`.
 */
export function truncatePayloadBytes(s: string, transcriptHint: string): string {
  const capped = truncateBytes(s, PLAN_PAYLOAD_CAP_BYTES);
  if (capped.length === s.length) return s;
  return `${capped}\n\n…(truncated at ${PLAN_PAYLOAD_CAP_BYTES / 1024} KB; the full plan body is in this run's planner transcript matching pattern \`${transcriptHint}\` under the worktree's \`ai_plan/<slug>/transcript/\` folder. Use your read/grep/find/ls tools to inspect the omitted sections directly if your verdict depends on them.)`;
}

/**
 * Cap byte length on a prior reviewer verdict text. On overflow append a
 * marker line pointing at the reviewer's transcript file; the next
 * round's reviewer can read the full prior verdict via its read tool if
 * P0/P1/P2 findings appeared past the cutoff. Without this marker, a
 * verbose / malformed prior verdict could silently drop findings off the
 * end and the next round would approve without verifying them.
 */
export function truncatePriorVerdict(s: string, transcriptHint: string): string {
  const capped = truncateBytes(s, 8_192);
  if (capped.length === s.length) return s;
  return `${capped}\n\n…(truncated at 8 KB; the full prior reviewer verdict is in the transcript matching pattern \`${transcriptHint}\` under \`ai_plan/<slug>/transcript/\`. If you suspect P0/P1/P2 findings fell past this cutoff, read the full transcript before approving.)`;
}

/**
 * Round-2+ verify-fixes prompt for PLAN-reviewer paths
 * (`sf_team_plan`, `sf_team_task`'s plan loop, `sf_team_followup`'s plan
 * loop). Mirrors the round-3+-anchored shape of
 * {@link "./impl-summary".composeImplVerifyFixesPrompt} — sections in
 * order: ORIGINAL PLAN (round 1, byte-capped, never changes across
 * rounds), PRIOR VERDICT (capped), CURRENT REVISED PLAN (capped). The
 * "anchored to round 1" trick prevents round 3+ from drifting from the
 * original plan structure.
 *
 * All three text inputs are capped internally — the caller passes raw
 * text. Truncation markers point the reviewer at the relevant transcript
 * file; the reviewer subprocess receives `cwd: ctx.repoRoot` (or the
 * worktree) so its `read,grep,find,ls` tools can fetch the omitted
 * sections directly when a verdict turns on truncated content.
 *
 * Use this for tools whose payload IS a full markdown artifact (plans,
 * not diffs). The impl-reviewer paths use the narrative-plus-diff-stat
 * version in `impl-summary.ts`.
 */
export function composePlanVerifyFixesPrompt(args: {
  /** Human-readable artifact label: "plan", "single-task plan", "followup plan". */
  label: string;
  /** Round-1 plan body, raw — capped internally. */
  originalPlan: string;
  /** Prior round's verdict text, raw — capped internally. */
  priorVerdictText: string;
  /** Round-N revised plan body, raw — capped internally. */
  currentPlan: string;
}): string {
  const upper = args.label.toUpperCase();
  return [
    `You previously reviewed this ${args.label} and emitted the verdict reproduced below. The author has revised in response. Your job for THIS review round is NARROW:`,
    "",
    `  1. For each P0/P1/P2 finding from your prior review, decide whether the revision adequately addresses it. Re-cite any finding that is STILL not addressed under the same severity bucket.`,
    `  2. Flag any NEW P0/P1/P2 issue that was DIRECTLY introduced by the revision itself — e.g. a section that was rewritten and now contradicts an acceptance criterion, or a fix that broke an unrelated invariant. Do NOT enumerate issues you could have found in the prior round but did not.`,
    `  3. P3 (cosmetic) findings from the prior round MAY be dropped silently; new P3 regressions need not be reported.`,
    "",
    `Decision rule:`,
    `  - VERDICT: APPROVED — when ALL prior P0/P1/P2 findings are adequately addressed AND the revision introduced no new P0/P1/P2 regressions.`,
    `  - VERDICT: REVISE   — otherwise. List ONLY (a) prior findings that remain unaddressed, plus (b) revision-introduced regressions.`,
    "",
    PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE,
    "",
    `--- ORIGINAL ${upper} (round 1; unchanged across rounds) ---`,
    truncatePayloadBytes(args.originalPlan, "planner-draft"),
    `--- END ORIGINAL ${upper} ---`,
    "",
    `--- PRIOR VERDICT (the findings you produced last round) ---`,
    truncatePriorVerdict(args.priorVerdictText, "reviewer-review"),
    `--- END PRIOR VERDICT ---`,
    "",
    `--- CURRENT REVISED ${upper} (what to evaluate now) ---`,
    truncatePayloadBytes(args.currentPlan, "planner-revision"),
    `--- END CURRENT REVISED ${upper} ---`,
  ].join("\n");
}

/**
 * Compose the round-2+ "verify-fixes" reviewer prompt shared across
 * `sf_team_plan`, `sf_team_implement`, and `sf_team_followup` (the
 * plan-reviewer AND impl-reviewer phases of the latter).
 *
 * Without this scoping the reviewer fresh-reviews the whole payload
 * each round and finds new things, so the loop never converges and
 * burns hours of agent time without ever approving. Scoped to
 * "verify the prior findings + catch revision-introduced regressions",
 * the loop converges: each round's findings can only shrink (closed
 * prior items + a small fixed set of regression candidates).
 *
 * The output ends BEFORE the verdict template — `makeReviewer`
 * appends `REVIEWER_VERDICT_TEMPLATE` itself, so every reviewer
 * spawn (round 1 or N) emits the same `## Findings` + `## Verdict`
 * shape regardless of the prompt body that preceded it.
 */
export function composeVerifyFixesPrompt(args: {
  /** Human-readable subject for the prompt — "plan" / "code change" / "followup plan" / etc. */
  label: string;
  /** Verdict text from the previous round (the one being addressed). */
  priorVerdictText: string;
  /** Payload the previous round reviewed (the one BEFORE the current revision). */
  priorPayload: string;
  /** Payload to review now (the revision the planner/developer produced in response to prior findings). */
  revisedPayload: string;
}): string {
  const upper = args.label.toUpperCase();
  return [
    `You previously reviewed this ${args.label} and emitted the verdict reproduced below. The author has revised in response. Your job for THIS review round is NARROW:`,
    "",
    `  1. For each P0/P1/P2 finding from your prior review, decide whether the revision adequately addresses it. Re-cite any finding that is STILL not addressed under the same severity bucket.`,
    `  2. Flag any NEW P0/P1/P2 issue that was DIRECTLY introduced by the revision itself — e.g. a section that was rewritten and now contradicts an acceptance criterion, or a fix that broke an unrelated invariant. Do NOT enumerate issues you could have found in the prior round but did not.`,
    `  3. P3 (cosmetic) findings from the prior round MAY be dropped silently; new P3 regressions need not be reported.`,
    "",
    `Decision rule:`,
    `  - VERDICT: APPROVED — when ALL prior P0/P1/P2 findings are adequately addressed AND the revision introduced no new P0/P1/P2 regressions.`,
    `  - VERDICT: REVISE   — otherwise. List ONLY (a) prior findings that remain unaddressed, plus (b) revision-introduced regressions.`,
    "",
    `--- PRIOR VERDICT (the findings you produced last round) ---`,
    args.priorVerdictText,
    `--- END PRIOR VERDICT ---`,
    "",
    `--- PRIOR ${upper} (what your prior verdict was reviewing) ---`,
    args.priorPayload,
    `--- END PRIOR ${upper} ---`,
    "",
    `--- REVISED ${upper} (what to evaluate now) ---`,
    args.revisedPayload,
    `--- END REVISED ${upper} ---`,
  ].join("\n");
}

/** Helper for invoking runReviewLoop with a string payload. */
export interface StringReviewLoop {
  initialPayload: string;
  reviewer: ReviewerFn<string>;
  revise: ReviseFn<string>;
  maxRounds: number;
  signal?: AbortSignal;
}

export type RunStringReviewLoop = (opts: StringReviewLoop) => Promise<{ approved: ReviewerVerdict; finalPayload: string; roundsUsed: number }>;

export function makeRunStringReviewLoop(deps: ToolDeps): RunStringReviewLoop {
  return async (opts) => {
    const r = await deps.runReviewLoop<string>({
      initialPayload: opts.initialPayload,
      reviewer: opts.reviewer,
      revise: opts.revise,
      maxRounds: opts.maxRounds,
      signal: opts.signal,
    } as RunReviewLoopOptions<string>);
    return { approved: r.approved, finalPayload: r.finalPayload, roundsUsed: r.roundsUsed };
  };
}

export type ToolUI = ExtensionUIContext;

/**
 * Run a string review loop, and on `MaxReviewRoundsError` write the
 * planner's last draft AND the reviewer's raw verdict text to the plan
 * folder before re-throwing. The error message is rewritten to name the
 * paths that were actually written; if a write failed, the message reports
 * the failure rather than silently lying.
 *
 * `subfolder` (optional, used by per-milestone implement loops) is appended
 * to the plan folder so each milestone gets its own last-draft/last-review
 * pair without overwriting siblings.
 */
export async function runLoopWithPartialOutput(
  runLoop: RunStringReviewLoop,
  opts: StringReviewLoop,
  ctx: { repoRoot: string; slug: string; subfolder?: string },
): Promise<{ approved: ReviewerVerdict; finalPayload: string; roundsUsed: number }> {
  try {
    return await runLoop(opts);
  } catch (err) {
    if (err instanceof MaxReviewRoundsError) {
      const written = await persistArtifacts(ctx, {
        lastPayload: err.lastPayload,
        lastVerdictText: err.lastVerdictText,
      });
      throw new MaxReviewRoundsError(
        `${err.message}. ${formatPartialOutputSuffix(written)}`,
        {
          lastVerdict: err.lastVerdict,
          lastVerdictText: err.lastVerdictText,
          lastPayload: err.lastPayload,
          history: err.history,
        },
      );
    }
    if (err instanceof RevisionUnchangedError) {
      const written = await persistArtifacts(ctx, {
        lastPayload: err.lastPayload,
        lastVerdictText: err.lastVerdictText,
      });
      const re = new RevisionUnchangedError(err.round, {
        lastPayload: err.lastPayload,
        lastVerdictText: err.lastVerdictText,
        lastVerdict: err.lastVerdict,
      });
      // Extend message with the same hint structure.
      (re as { message: string }).message = `${re.message} ${formatPartialOutputSuffix(written)}`;
      throw re;
    }
    if (err instanceof ReviewerEmptyVerdictError) {
      // Persist whatever the reviewer DID produce on the prior round (if
      // any) so the user can inspect it. priorVerdictText is undefined on
      // round 1 (no prior); fall back to a placeholder string so
      // last-review.md is not silently wiped.
      const written = await persistArtifacts(ctx, {
        lastPayload: err.lastPayload as unknown,
        lastVerdictText: err.priorVerdictText ?? "(reviewer produced no verdict text on the empty round; no prior round to cite)",
      });
      const re = new ReviewerEmptyVerdictError(err.round, {
        lastPayload: err.lastPayload,
        priorVerdictText: err.priorVerdictText,
      });
      (re as { message: string }).message = `${re.message} ${formatPartialOutputSuffix(written)}`;
      throw re;
    }
    throw err;
  }
}

function formatPartialOutputSuffix(
  written: { draftPath?: string; reviewPath?: string; draftError?: string; reviewError?: string },
): string {
  const parts: string[] = [];
  if (written.draftPath) parts.push(`last-draft.md=${written.draftPath}`);
  else parts.push(`last-draft.md=(WRITE FAILED: ${written.draftError})`);
  if (written.reviewPath) parts.push(`last-review.md=${written.reviewPath}`);
  else parts.push(`last-review.md=(WRITE FAILED: ${written.reviewError})`);
  return `Partial output: ${parts.join(", ")}.`;
}

async function persistArtifacts(
  ctx: { repoRoot: string; slug: string; subfolder?: string; planRoot?: string },
  err: { lastPayload: unknown; lastVerdictText: string },
): Promise<{ draftPath?: string; reviewPath?: string; draftError?: string; reviewError?: string }> {
  const resolvedPlanRoot = ctx.planRoot ?? path.join(ctx.repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const base = planFolderPathFromRoot(resolvedPlanRoot, ctx.slug);
  const folder = ctx.subfolder ? path.join(base, ctx.subfolder) : base;
  try {
    await mkdir(folder, { recursive: true });
  } catch (mkdirErr) {
    const msg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
    return { draftError: msg, reviewError: msg };
  }
  const draftFile = path.join(folder, "last-draft.md");
  const reviewFile = path.join(folder, "last-review.md");
  const draftBody = typeof err.lastPayload === "string"
    ? err.lastPayload
    : JSON.stringify(err.lastPayload, null, 2);
  let draftPath: string | undefined;
  let draftError: string | undefined;
  try {
    await writeFile(draftFile, draftBody, "utf8");
    draftPath = draftFile;
  } catch (e) {
    draftError = e instanceof Error ? e.message : String(e);
  }
  let reviewPath: string | undefined;
  let reviewError: string | undefined;
  try {
    await writeFile(reviewFile, err.lastVerdictText || "(reviewer produced no verdict text)", "utf8");
    reviewPath = reviewFile;
  } catch (e) {
    reviewError = e instanceof Error ? e.message : String(e);
  }
  return { draftPath, reviewPath, draftError, reviewError };
}

/**
 * Runtime-composed developer system preamble that carries the git/staging
 * contract so it can adapt to gitMode without baking it into the static YAML.
 *
 * gitMode='on'  — staging + commit contract (the four sentences previously
 *                 in developer.yaml that the orchestrator now supplies at
 *                 spawn time).
 * gitMode='off' — no-git instructions; developer edits files directly and
 *                 emits a ## Changes summary.
 */
export function composeDeveloperSystemPreamble(opts: { gitMode?: "on" | "off" } = {}): string {
  if (opts.gitMode === "off") {
    return [
      "Edit files directly via Edit/Write tools. Do NOT use git commands.",
      "The orchestrator will not commit, branch, or create a worktree for this run.",
      "In your handoff message, emit a `## Changes` block listing every modified or created file path.",
    ].join("\n");
  }
  return [
    "Stage only the files YOU touched in this run; never git add -A.",
    "DO NOT run `git commit` — the orchestrator commits after impl-review approves your staged diff.",
    "Worktree creation is also handled by the orchestrator before you spawn — you do not need to create or switch worktrees yourself.",
  ].join("\n");
}
