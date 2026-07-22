import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadAndResolveDefaults } from "./config/load";
import { resolveRuntime } from "./config/resolve-runtime";
import { GIT_MODES, TDD_MODES, VerificationConfigSchema, type ResolvedDefaults } from "./config/schema";
import { effectiveUi } from "./config/workflow";
import { wrapExecute } from "./errors";
import { formatFinalCostSentence, type CostSummary } from "./orchestrator/cost";
import { parseStoryTracker, type ParsedMilestone } from "./plan/tracker";
import { createSfTeamAuto, type SfTeamAutoResult } from "./tools/auto";
import { createSfTeamFollowup } from "./tools/followup";
import { createSfTeamImplement, type SfTeamImplementResult } from "./tools/implement";
import { createDefaultExternalFetcher } from "./research/default-fetcher";
import { createSfTeamPlan, type SfTeamPlanResult } from "./tools/plan";
import { createSfTeamSteer, SfTeamSteerSchema, type SfTeamSteerParams, type SfTeamSteerResult } from "./tools/steer";
import { teamDeprecatedDescriptionPrefix, prependTeamDeprecationNotice } from "./deprecation";
import { createSfTeamTask, type SfTeamTaskResult } from "./tools/task";
import { createSfTeamResume } from "./tools/resume-dispatch";

/**
 * Resolve config (~/.pi/sf/team/config.json + repo .pi/sf/team/config.json
 * → DEFAULT_CONFIG fallback). Surface load errors via ui.notify so the
 * user sees that their config was ignored. Called once per tool execute.
 */
async function resolveCtxDefaults(ui: ExtensionUIContext | undefined): Promise<ResolvedDefaults> {
  return loadAndResolveDefaults(process.cwd(), {
    notify: ui?.notify ? (msg, level) => ui.notify(msg, level) : undefined,
  });
}

/**
 * Production tool surface for the sf-team extension.
 *
 * Each base tool name (`sf_team_plan`, `sf_team_implement`, `sf_team_task`,
 * `sf_team_auto`, `sf_team_followup`) registers TWO Pi tools:
 *   - `<base>` — flat single-mode schema for new runs
 *
 * A single unified `sf_team_resume` tool handles resuming any base tool.
 *
 * The historical M1 split that also registered a permissive `<base>`
 * legacy alias throwing `LegacyAliasError` is removed; the start tool
 * now lives at the bare base name. This keeps the LLM-facing tool count
 * minimal (7 names total) and matches the names LLMs already remember
 * from training data, while the strict per-tool schemas (no top-level
 * `anyOf` union) preserve the M1 win against schema-validation churn.
 */
export const TEAM_BASE_TOOL_NAMES = [
  "sf_team_plan",
  "sf_team_implement",
  "sf_team_task",
  "sf_team_auto",
  "sf_team_followup",
] as const;

export type TeamBaseToolName = (typeof TEAM_BASE_TOOL_NAMES)[number];

export const TEAM_STEER_TOOL_NAME = "sf_team_steer" as const;

export const TEAM_RESUME_TOOL_NAME = "sf_team_resume" as const;

/**
 * Enumerates the FULL Pi tool surface sf-team registers (5 base +
 * unified resume + standalone steer = 7 names).
 */
export const TEAM_TOOL_NAMES = [...TEAM_BASE_TOOL_NAMES, TEAM_RESUME_TOOL_NAME, TEAM_STEER_TOOL_NAME] as readonly TeamToolName[];

export type TeamToolName = TeamBaseToolName | typeof TEAM_RESUME_TOOL_NAME | typeof TEAM_STEER_TOOL_NAME;

export function registerSfTeam(pi: ExtensionAPI): void {
  // Maintain TEAM_BASE_TOOL_NAMES order so smoke-test enumeration is stable.
  for (const name of TEAM_BASE_TOOL_NAMES) {
    if (name === "sf_team_plan") registerPlanTool(pi);
    else if (name === "sf_team_task") registerTaskTool(pi);
    else if (name === "sf_team_implement") registerImplementTool(pi);
    else if (name === "sf_team_auto") registerAutoTool(pi);
    else if (name === "sf_team_followup") registerFollowupTool(pi);
  }
  registerResumeTool(pi);
  registerSteerTool(pi);
  registerSlashCommands(pi);
}

interface ToolExecuteOutcome<TResult> {
  content: Array<{ type: string; text: string }>;
  details: TResult;
}

interface ResultWithCostSummary {
  costSummary?: CostSummary;
}

function appendCostSentence<T extends ResultWithCostSummary>(text: string, result: T): string {
  const sentence = formatFinalCostSentence(result.costSummary);
  return sentence ? `${text} ${sentence}` : text;
}

function withCostSummaryGuidance(description: string): string {
  return `${description} When the tool result contains a known cost sentence like "Your total cost is $9.99.", extract the actual amount from the tool result and include that cost in your final user-facing summary as "Total cost: $<amount>" (for example, "Total cost: $9.99").`;
}

function makeExecCtx(
  toolName: string,
  signal: AbortSignal | null | undefined,
  ctx: { hasUI?: boolean; ui?: ExtensionUIContext } | undefined,
): PiToolExecuteCtx {
  return {
    toolName,
    signal: signal ?? undefined,
    hasUI: ctx?.hasUI,
    ui: ctx?.hasUI ? ctx.ui : undefined,
  };
}

async function runExec<T>(p: Promise<ToolExecuteOutcome<T>>): Promise<{ content: Array<{ type: "text"; text: string }>; details: T }> {
  const outcome = await p;
  return {
    content: outcome.content.map((c) => ({ type: "text" as const, text: c.text })),
    details: outcome.details,
  };
}

/**
 * Subset of Pi's per-call execute context that sf-team handlers consume.
 * Kept loose to avoid coupling to Pi internal types beyond what each
 * handler actually reads. `toolName` is the registered Pi tool name
 * (`<base>` for the start variant, `sf_team_resume` for resume) so inner
 * handlers can compose typed-error messages with the right surface name.
 */
interface PiToolExecuteCtx {
  toolName: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  ui?: ExtensionUIContext;
}

/**
 * Convert a tool name (underscore) to a slash-command name (hyphen).
 * e.g. `sf_team_plan` → `sf-team-plan`, `sf_team_resume` → `sf-team-resume`
 */
function toolToCommandName(toolName: string): string {
  return toolName.replace(/_/g, "-");
}

/**
 * Register `/sf-team-*` slash commands so the team tools appear in pi's
 * `/` menu. Each base name registers ONE command:
 *   - `/<base>` — directs the agent to call the start tool
 *
 * A single `/sf-team-resume` command directs the agent to call the
 * unified `sf_team_resume` tool for resuming any workflow.
 *
 * Slash commands use hyphens (`sf-team-plan`); tool names keep underscores
 * (`sf_team_plan`). Defensive against older pi runtimes: if
 * `registerCommand` or `sendUserMessage` is missing, we degrade gracefully
 * instead of throwing during extension load.
 */
function registerSlashCommands(pi: ExtensionAPI): void {
  if (typeof pi.registerCommand !== "function") return;

  const send = typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;
  const steerHandler = createSfTeamSteer();

  for (const base of TEAM_BASE_TOOL_NAMES) {
    const startHint = startHintForBase(base);

    registerOne(toolToCommandName(base), `${describeStartTool(base)} Args: ${startHint}.`, (trimmed) =>
      trimmed.length === 0
        ? `Invoke the ${base} tool. Ask me first for the ${startHint}.`
        : `Invoke the ${base} tool with: ${trimmed}`,
    );
  }

  registerOne("sf-team-resume", "Resume any in-progress sf-team workflow. Args: optional slug to resume.", (trimmed) =>
    trimmed.length === 0
      ? "Invoke the sf_team_resume tool. Ask me first for the slug to resume, or omit to resume the latest."
      : `Invoke the sf_team_resume tool with: ${trimmed}`,
  );

  pi.registerCommand(toolToCommandName(TEAM_STEER_TOOL_NAME), {
    description: "Send an instruction to an active sf-team workflow. Args: optional workflowId=<id>, planSlug=<slug>, aiPlanPath=<dir> plus instruction.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        await postSlashPrompt(
          TEAM_STEER_TOOL_NAME,
          trimmed,
          "Invoke the sf_team_steer tool. Ask me first for the instruction and, if needed, the workflowId or planSlug.",
          ctx,
        );
        return;
      }

      const params = parseSteerSlashArgs(trimmed);
      if (!params) {
        ctx.ui?.notify?.(
          "sf_team_steer: include instruction text, optionally with workflowId=<id> or planSlug=<slug>.",
          "warning",
        );
        return;
      }

      try {
        const repoRoot = process.cwd();
        const ui = ctx?.ui as import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
        const configDefaults = await resolveCtxDefaults(ui);
        const { planRoot } = resolveRuntime({ prompt: { aiPlanPath: params.aiPlanPath }, defaults: configDefaults, repoRoot });
        const resolvedParams = { ...params, aiPlanPath: planRoot };
        const result = await steerHandler(resolvedParams, { repoRoot, aiPlanPath: planRoot });
        notifySteerSlashResult(ctx.ui, result);
      } catch (err) {
        ctx.ui?.notify?.(`sf_team_steer: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  function registerOne(
    name: string,
    description: string,
    build: (trimmed: string) => string,
    opts: { busyDelivery?: "steer" | "followUp" } = {},
  ): void {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        const message = build(trimmed);
        await postSlashPrompt(name, trimmed, message, ctx, opts.busyDelivery ?? "followUp");
      },
    });
  }

  async function postSlashPrompt(
    name: string,
    trimmed: string,
    message: string,
    ctx: { isIdle?: () => boolean; ui?: ExtensionUIContext },
    busyDelivery: "steer" | "followUp" = "followUp",
  ): Promise<void> {
    if (!send) {
      if (ctx.ui?.notify) {
        ctx.ui.notify(
          `sf-team: this pi runtime can't post slash-command output to the agent. Type "${name} ${trimmed}" instead.`,
          "warning",
        );
      }
      return;
    }
    // When the agent is mid-stream, sendUserMessage requires a delivery
    // mode or the runtime drops it. Use followUp for ordinary commands;
    // sf_team_steer non-empty input bypasses this path and writes the
    // durable steering inbox directly.
    const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    if (idle) {
      send(message);
    } else {
      send(message, { deliverAs: busyDelivery });
    }
  }
}

function parseSteerSlashArgs(trimmed: string): SfTeamSteerParams | undefined {
  const matches = Array.from(trimmed.matchAll(/(?:^|\s)([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g));
  if (matches.length === 0) return { instruction: trimmed };

  const values = new Map<string, string>();
  const spans: Array<[number, number]> = [];
  const knownKeys = new Set(["workflowid", "planslug", "priority", "instruction", "aiplanpath"]);
  for (const match of matches) {
    const rawKey = match[1] ?? "";
    const key = rawKey.toLowerCase().replace(/[-_]/g, "");
    if (!knownKeys.has(key)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    values.set(key, value);
    spans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  let remainder = "";
  let previousEnd = 0;
  for (const [start, end] of spans) {
    remainder += trimmed.slice(previousEnd, start);
    previousEnd = end;
  }
  remainder += trimmed.slice(previousEnd);

  const instruction = (values.get("instruction") ?? remainder).trim();
  if (instruction.length === 0) return undefined;

  const priority = values.get("priority");
  return {
    instruction,
    workflowId: blankToUndefined(values.get("workflowid")),
    planSlug: blankToUndefined(values.get("planslug")),
    priority: priority === "urgent" || priority === "normal" ? priority : undefined,
    aiPlanPath: blankToUndefined(values.get("aiplanpath")),
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function notifySteerSlashResult(ui: ExtensionUIContext | undefined, result: SfTeamSteerResult): void {
  const message = result.ok
    ? `sf_team_steer: queued instruction ${result.instructionId} for workflow ${result.workflowId}.`
    : `sf_team_steer: ${result.reason}; ${result.message}`;
  ui?.notify?.(message, result.ok ? "info" : "warning");
}

function startHintForBase(base: TeamBaseToolName): string {
  switch (base) {
    case "sf_team_plan":
      return "title (and optionally brief, aiPlanPath, gitMode, tddMode)";
    case "sf_team_implement":
      return "slug of the plan folder to implement (optionally aiPlanPath, gitMode, tddMode)";
    case "sf_team_task":
      return "title (and optionally brief, aiPlanPath, gitMode, tddMode)";
    case "sf_team_auto":
      return "title (and optionally brief, aiPlanPath, gitMode, tddMode)";
    case "sf_team_followup":
      return "title of the follow-up (optionally aiPlanPath, gitMode, tddMode); parent plan is auto-detected";
  }
}

function describeStartTool(base: TeamBaseToolName): string {
  switch (base) {
    case "sf_team_plan":
      return "Draft a multi-milestone plan via planner+reviewer agents and write a 5-file plan folder. Supports aiPlanPath, gitMode ('auto'|'on'|'off'), tddMode ('auto'|'on'|'off').";
    case "sf_team_implement":
      return "Implement an approved plan folder via developer+reviewer agents (single-milestone by default). Supports aiPlanPath, gitMode, tddMode.";
    case "sf_team_task":
      return "Single-task end-to-end: plan-review → implement → verify → impl-review → commit. Supports aiPlanPath, gitMode ('auto'|'on'|'off'), tddMode ('auto'|'on'|'off').";
    case "sf_team_auto":
      return "Chain sf_team_plan and sf_team_implement (all-milestones) with no human gates. Supports aiPlanPath, gitMode, tddMode.";
    case "sf_team_followup":
      return "Draft and implement a follow-up to an existing plan; writes a brand-new sibling plan folder under ai_plan/<date>-followup-<slug>/. Supports aiPlanPath, gitMode, tddMode.";
  }
}

function registerResumeTool(pi: ExtensionAPI): void {
  const handler = createSfTeamResume();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const resumeSchema = Type.Object(
    {
      resume: Type.Optional(Type.String({ description: "Plan-folder slug, absolute path, or relative path. If omitted, resumes the most recently active workflow." })),
      maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      allowDirty: Type.Optional(Type.Boolean()),
      verification: Type.Optional(VerificationConfigSchema),
      aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are read from. Defaults to ./ai_plan/." })),
      gitMode: Type.Optional(GitModeSchema),
      tddMode: Type.Optional(TddModeSchema),
    },
    { additionalProperties: false },
  );

  const exec = async (p: Record<string, any>, pctx: PiToolExecuteCtx) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const repoRoot = process.cwd();
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    const runtime = resolveRuntime({
      prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode },
      defaults: configDefaults,
      repoRoot,
    });
    const { ownerTool, result } = await handler(
      {
        resume: p.resume,
        maxRounds: p.maxRounds,
        allowDirty: p.allowDirty,
        verification: p.verification,
      },
      {
        repoRoot,
        signal: pctx.signal ?? undefined,
        ui: toolUi,
        configDefaults,
        planRoot: runtime.planRoot,
        gitMode: runtime.gitMode,
        tddMode: runtime.tddMode,
        rawGitMode: runtime.raw.gitMode,
        rawTddMode: runtime.raw.tddMode,
      },
    );
    return {
      content: [{ type: "text", text: `sf_team_resume: resumed ${ownerTool} workflow for slug ${(result as any).slug ?? "(unknown)"}.` }],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<unknown>>(
    TEAM_RESUME_TOOL_NAME,
    async (_id, params, signal, _onUpdate, ctx) => {
      return exec(params, makeExecCtx(TEAM_RESUME_TOOL_NAME, signal, ctx));
    },
  );

  pi.registerTool({
    name: TEAM_RESUME_TOOL_NAME,
    label: TEAM_RESUME_TOOL_NAME,
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_resume") +
      "Resume any in-progress sf-team workflow by slug, path, or latest. Reads workflow.json to determine which tool owns the workflow and dispatches accordingly. Accepts aiPlanPath, gitMode, tddMode.",
    ),
    parameters: resumeSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_resume", r)),
  });
}

function registerSteerTool(pi: ExtensionAPI): void {
  const handler = createSfTeamSteer();
  const wrapped = wrapExecute<SfTeamSteerParams, ToolExecuteOutcome<SfTeamSteerResult>>(
    TEAM_STEER_TOOL_NAME,
    async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = process.cwd();
      const ui = ctx?.ui as import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
      const configDefaults = await resolveCtxDefaults(ui);
      const { planRoot } = resolveRuntime({ prompt: { aiPlanPath: params.aiPlanPath }, defaults: configDefaults, repoRoot });
      const result = await handler({ ...params, aiPlanPath: planRoot }, { repoRoot, aiPlanPath: planRoot });
      const text = result.ok
        ? `sf_team_steer: queued instruction ${result.instructionId} for workflow ${result.workflowId}.`
        : `sf_team_steer: ${result.reason}; ${result.message}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  );

  pi.registerTool({
    name: TEAM_STEER_TOOL_NAME,
    label: TEAM_STEER_TOOL_NAME,
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_steer") +
      "Send a steering instruction to an active sf-team workflow. Targets by workflowId, planSlug, or the single active workflow. Standalone ingress only; there is no sf_team_steer_resume.",
    ),
    parameters: SfTeamSteerSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as SfTeamSteerParams, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_steer", r)),
  });
}

function registerPlanTool(pi: ExtensionAPI): void {
  const handler = createSfTeamPlan();
  // Default external fetcher (URL via web, Jira/Confluence via
  // atlassian). Constructed once per registration; the same instance is
  // reused for every sf_team_plan call. Tests inject their own fetcher
  // via the handler's `input.externalFetcher` parameter directly, so
  // wiring it here does NOT override test-provided fetchers — tests
  // continue to take precedence.
  const defaultExternalFetcher = createDefaultExternalFetcher();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const startSchema = Type.Object(
    {
      title: Type.String({ description: "Short title used as the slug seed and brief." }),
      brief: Type.Optional(Type.String({ description: "Detailed requirements / context for the planner." })),
      maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      verification: Type.Optional(VerificationConfigSchema),
      aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are written. Defaults to ./ai_plan/." })),
      gitMode: Type.Optional(GitModeSchema),
      tddMode: Type.Optional(TddModeSchema),
    },
    { additionalProperties: false },
  );

  const exec = async (
    p: Record<string, any>,
    pctx: PiToolExecuteCtx,
  ) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const repoRoot = process.cwd();
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    const runtime = resolveRuntime({
      prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode },
      defaults: configDefaults,
      repoRoot,
    });
    const result = await handler(
      {
        title: p.title,
        resume: p.resume,
        brief: p.brief,
        maxRounds: p.maxRounds,
        verification: p.verification,
        externalFetcher: defaultExternalFetcher,
      },
      {
        repoRoot,
        signal: pctx.signal ?? undefined,
        ui: toolUi,
        configDefaults,
        toolName: pctx.toolName,
        planRoot: runtime.planRoot,
        gitMode: runtime.gitMode,
        tddMode: runtime.tddMode,
      },
    );
    return {
      content: [{ type: "text", text: appendCostSentence(`sf_team_plan: ${result.approved ? "approved" : "not approved"} after ${result.rounds} rounds; folder=${result.folderPath ?? "(none)"}; performance=${result.performanceReportPath ?? "(none)"}`, result) }],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<SfTeamPlanResult>>("sf_team_plan", async (_id, params, signal, _onUpdate, ctx) => {
    return exec(params, makeExecCtx("sf_team_plan", signal, ctx));
  });

  pi.registerTool({
    name: "sf_team_plan",
    label: "sf_team_plan",
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_plan") +
      "Draft a multi-milestone plan via planner+reviewer agents and write a 5-file plan folder. Begins a new run; required: `title`.",
    ),
    parameters: startSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_plan", r)),
  });
}

function registerTaskTool(pi: ExtensionAPI): void {
  const handler = createSfTeamTask();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const startSchema = Type.Object(
    {
      title: Type.String({ description: "Task title (used as the slug)." }),
      brief: Type.Optional(Type.String()),
      maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      allowDirty: Type.Optional(Type.Boolean({ description: "Skip dirty-worktree guard." })),
      verification: Type.Optional(VerificationConfigSchema),
      aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are written. Defaults to ./ai_plan/." })),
      gitMode: Type.Optional(GitModeSchema),
      tddMode: Type.Optional(TddModeSchema),
    },
    { additionalProperties: false },
  );

  const exec = async (p: Record<string, any>, pctx: PiToolExecuteCtx) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const repoRoot = process.cwd();
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    const runtime = resolveRuntime({ prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode }, defaults: configDefaults, repoRoot });
    const shouldPush = async (): Promise<boolean> => {
      if (!toolUi) return false; // headless mode: never push
      return (await toolUi.confirm("Push this commit?", `Push to remote now?`)) === true;
    };
    const result = await handler(
      {
        title: p.title,
        resume: p.resume,
        brief: p.brief,
        maxRounds: p.maxRounds,
        allowDirty: p.allowDirty,
        verification: p.verification,
        shouldPush,
      },
      { repoRoot, signal: pctx.signal ?? undefined, ui: toolUi, configDefaults, toolName: pctx.toolName, planRoot: runtime.planRoot, gitMode: runtime.gitMode, tddMode: runtime.tddMode, rawGitMode: runtime.raw.gitMode, rawTddMode: runtime.raw.tddMode },
    );
    return {
      content: [
        {
          type: "text",
          text: appendCostSentence(`sf_team_task: ${result.approved ? "approved" : "not approved"}; commit=${result.commitSha ?? "(none)"}; pushed=${result.pushed}; performance=${result.performanceReportPath ?? "(none)"}`, result),
        },
      ],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<SfTeamTaskResult>>("sf_team_task", async (_id, params, signal, _onUpdate, ctx) => {
    return exec(params, makeExecCtx("sf_team_task", signal, ctx));
  });

  pi.registerTool({
    name: "sf_team_task",
    label: "sf_team_task",
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_task") +
      "End-to-end single-task workflow: plan-review → implement → verify → impl-review → commit. Begins a new run; required: `title`.",
    ),
    parameters: startSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_task", r)),
  });
}

function registerImplementTool(pi: ExtensionAPI): void {
  const handler = createSfTeamImplement();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const sharedFields = {
    mode: Type.Optional(Type.Union([Type.Literal("single-milestone"), Type.Literal("all-milestones")])),
    maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    useWorktree: Type.Optional(Type.Boolean()),
    branchPrefix: Type.Optional(Type.String()),
    pauseBetweenMilestones: Type.Optional(Type.Boolean({
      description:
        "When true, pause and ask the user to confirm between each milestone. When false, run end-to-end. Default: per-tool config (`implement.pause_between_milestones=true`, `auto.pause_between_milestones=false`).",
    })),
    verification: Type.Optional(VerificationConfigSchema),
    aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are read from and written to. Defaults to ./ai_plan/." })),
    gitMode: Type.Optional(GitModeSchema),
    tddMode: Type.Optional(TddModeSchema),
  } as const;
  const startSchema = Type.Object(
    {
      slug: Type.String({ description: "Plan-folder slug under ai_plan/." }),
      ...sharedFields,
    },
    { additionalProperties: false },
  );

  const exec = async (p: Record<string, any>, pctx: PiToolExecuteCtx) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    // NOTE: production registration does NOT pass a `shouldContinue`
    // callback. The inter-milestone pause is driven entirely by the
    // `pauseBetweenMilestones` config knob (resolution: prompt arg →
    // project config → global config → DEFAULT_CONFIG.implement.pause_between_milestones=true).
    // Tests can still inject `shouldContinue` directly via the input
    // type to exercise specific gate behaviors deterministically.
    const repoRoot = process.cwd();
    const runtime = resolveRuntime({ prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode }, defaults: configDefaults, repoRoot });
    const result = await handler(
      {
        slug: p.slug,
        resume: p.resume,
        mode: p.mode,
        maxRounds: p.maxRounds,
        useWorktree: p.useWorktree,
        branchPrefix: p.branchPrefix,
        pauseBetweenMilestones: p.pauseBetweenMilestones,
        verification: p.verification,
      },
      { repoRoot, signal: pctx.signal ?? undefined, ui: toolUi, configDefaults, toolName: pctx.toolName, planRoot: runtime.planRoot, gitMode: runtime.gitMode, tddMode: runtime.tddMode, rawGitMode: runtime.raw.gitMode, rawTddMode: runtime.raw.tddMode },
    );
    return {
      content: [
        {
          type: "text",
          text: appendCostSentence(await formatImplementResultText(result, repoRoot), result),
        },
      ],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<SfTeamImplementResult>>("sf_team_implement", async (_id, params, signal, _onUpdate, ctx) => {
    return exec(params, makeExecCtx("sf_team_implement", signal, ctx));
  });

  pi.registerTool({
    name: "sf_team_implement",
    label: "sf_team_implement",
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_implement") +
      "Read an approved plan folder and implement milestones via developer+reviewer agents (D1 default). Begins a new run; required: `slug`.",
    ),
    parameters: startSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_implement", r)),
  });
}

async function formatImplementResultText(result: SfTeamImplementResult, repoRoot: string): Promise<string> {
  const approvedThisRun = result.milestones.filter((m) => m.approved).length;
  let text = `sf_team_implement: ${approvedThisRun} milestone(s) approved this run on branch ${result.branch ?? "(no branch)"}.`;
  const progress = await readPlanProgress(repoRoot, result.slug).catch(() => undefined);
  if (progress) {
    const pendingSuffix = progress.pendingIds.length > 0 ? ` (${progress.pendingIds.join(", ")})` : "";
    text += ` Plan status: ${progress.approved}/${progress.total} milestone(s) approved; ${progress.pendingIds.length} pending${pendingSuffix}.`;
    if (progress.pendingIds.length > 0) {
      text += ` Next: ask whether to continue with ${progress.pendingIds[0]}.`;
    }
  }
  if (result.performanceReportPath) {
    text += ` Performance: ${result.performanceReportPath}.`;
  }
  // M4: surface lane-branch cleanup warnings count so the user sees that
  // teardown noticed something even when the run otherwise succeeded.
  if (result.warnings && result.warnings.length > 0) {
    text += ` Branch cleanup warnings: ${result.warnings.length} (see details.warnings).`;
  }
  return text;
}

/**
 * Render the result text for `sf_team_auto`. Modeled on
 * `formatImplementResultText` but with an explicit
 * `SUCCESS` / `PARTIAL` / `NO-OP` prefix so calling LLMs cannot
 * misread "5 milestone(s)" as "5 milestones still pending."
 *
 * Three cases:
 * - **NO-OP**: this invocation processed zero milestones AND the plan
 *   folder is at N/N approved. Typically a resume-after-completion.
 * - **SUCCESS**: this invocation processed >= 1 milestone AND the plan
 *   is now at N/N approved (zero pending).
 * - **PARTIAL**: this invocation processed >= 1 milestone but the plan
 *   still has pending milestones (interrupted run, max-rounds hit on
 *   one milestone, etc.). Includes a Next: hint with the first pending
 *   milestone id so the calling LLM knows exactly which resume to
 *   issue.
 *
 * Performance + branch-cleanup warnings are appended unchanged from
 * the implement formatter.
 */
async function formatAutoResultText(
  result: { planRounds: number; implement: SfTeamImplementResult; performanceReportPaths?: string[] },
  repoRoot: string,
): Promise<string> {
  const implResult = result.implement;
  const approvedThisRun = implResult.milestones.filter((m) => m.approved).length;
  const totalThisRun = implResult.milestones.length;
  const progress = await readPlanProgress(repoRoot, implResult.slug).catch(() => undefined);
  const planStatus = progress
    ? `Plan status: ${progress.approved}/${progress.total} milestone(s) approved; ${progress.pendingIds.length} pending${progress.pendingIds.length > 0 ? ` (${progress.pendingIds.join(", ")})` : ""}.`
    : undefined;

  let prefix: string;
  let runSummary: string;
  if (totalThisRun === 0 && progress && progress.pendingIds.length === 0) {
    // NO-OP: the resume found nothing to do because the plan was
    // already complete. Make this unambiguous so the calling LLM
    // doesn't conclude "I need to retry" or "the implementation
    // failed."
    prefix = "NO-OP";
    runSummary = `nothing to do this run; plan already at ${progress.approved}/${progress.total} approved.`;
  } else if (progress && progress.pendingIds.length === 0 && approvedThisRun > 0) {
    prefix = "SUCCESS";
    runSummary = `plan reviewed in ${result.planRounds} round(s); ${approvedThisRun}/${totalThisRun} milestone(s) approved this run on branch ${implResult.branch ?? "(no branch)"}.`;
  } else {
    prefix = "PARTIAL";
    runSummary = `plan reviewed in ${result.planRounds} round(s); ${approvedThisRun}/${totalThisRun} milestone(s) approved this run on branch ${implResult.branch ?? "(no branch)"}.`;
  }

  const parts: string[] = [`sf_team_auto: ${prefix} — ${runSummary}`];
  if (planStatus) parts.push(planStatus);
  if (prefix === "PARTIAL" && progress && progress.pendingIds.length > 0) {
    parts.push(`Next: invoke sf_team_resume { resume: '${implResult.slug}' } to continue with ${progress.pendingIds[0]}.`);
  }
  if (implResult.warnings && implResult.warnings.length > 0) {
    parts.push(`Branch cleanup warnings: ${implResult.warnings.length} (see details.implement.warnings).`);
  }
  const perf = (result.performanceReportPaths ?? []).join(", ");
  parts.push(`Performance: ${perf || "(none)"}.`);
  return parts.join(" ");
}

async function readPlanProgress(repoRoot: string, slug: string): Promise<{ total: number; approved: number; pendingIds: string[] }> {
  const tracker = await parseStoryTracker(repoRoot, slug);
  return {
    total: tracker.milestones.length,
    approved: tracker.milestones.filter(isMilestoneApproved).length,
    pendingIds: tracker.milestones.filter(hasRunnableStories).map((milestone) => milestone.id),
  };
}

function isMilestoneApproved(milestone: ParsedMilestone): boolean {
  return /^approved\b/i.test(milestone.approvalStatus ?? "");
}

function hasRunnableStories(milestone: ParsedMilestone): boolean {
  return milestone.stories.some((story) => story.status === "pending" || story.status === "in-dev" || story.status === "needs-rework");
}

function registerAutoTool(pi: ExtensionAPI): void {
  const handler = createSfTeamAuto();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const sharedFields = {
    maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    branchPrefix: Type.Optional(Type.String()),
    pauseBetweenMilestones: Type.Optional(Type.Boolean({
      description:
        "When true, pause and ask the user to confirm between each milestone. When false (default for sf_team_auto), run end-to-end.",
    })),
    verification: Type.Optional(VerificationConfigSchema),
    aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are read from and written to. Defaults to ./ai_plan/." })),
    gitMode: Type.Optional(GitModeSchema),
    tddMode: Type.Optional(TddModeSchema),
  } as const;
  const startSchema = Type.Object(
    {
      title: Type.String(),
      brief: Type.Optional(Type.String()),
      ...sharedFields,
    },
    { additionalProperties: false },
  );

  const exec = async (p: Record<string, any>, pctx: PiToolExecuteCtx) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    const repoRoot = process.cwd();
    const runtime = resolveRuntime({ prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode }, defaults: configDefaults, repoRoot });
    const result = await handler(
      {
        title: p.title,
        resume: p.resume,
        brief: p.brief,
        maxRounds: p.maxRounds,
        branchPrefix: p.branchPrefix,
        pauseBetweenMilestones: p.pauseBetweenMilestones,
        verification: p.verification,
      },
      { repoRoot, signal: pctx.signal ?? undefined, ui: toolUi, configDefaults, toolName: pctx.toolName, planRoot: runtime.planRoot, gitMode: runtime.gitMode, tddMode: runtime.tddMode, rawGitMode: runtime.raw.gitMode, rawTddMode: runtime.raw.tddMode },
    );
    return {
      content: [
        {
          type: "text",
          text: appendCostSentence(await formatAutoResultText(result, repoRoot), result),
        },
      ],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<SfTeamAutoResult>>("sf_team_auto", async (_id, params, signal, _onUpdate, ctx) => {
    return exec(params, makeExecCtx("sf_team_auto", signal, ctx));
  });

  pi.registerTool({
    name: "sf_team_auto",
    label: "sf_team_auto",
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_auto") +
      "Chain sf_team_plan and sf_team_implement (all-milestones) with no human gates between. Begins a new run; required: `title`.",
    ),
    parameters: startSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_auto", r)),
  });
}

function registerFollowupTool(pi: ExtensionAPI): void {
  const handler = createSfTeamFollowup();
  const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
  const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));
  const sharedFields = {
    parentPlan: Type.Optional(Type.String({ description: "Override parent plan auto-detection. Accepts a slug (e.g. 2026-05-08-add-foo), a relative path (./ai_plan/2026-05-08-add-foo), or an absolute path." })),
    allowDirty: Type.Optional(Type.Boolean()),
    maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    verification: Type.Optional(VerificationConfigSchema),
    aiPlanPath: Type.Optional(Type.String({ description: "Directory where plan folders are read from and written to. Defaults to ./ai_plan/." })),
    gitMode: Type.Optional(GitModeSchema),
    tddMode: Type.Optional(TddModeSchema),
  } as const;
  const startSchema = Type.Object(
    {
      title: Type.String(),
      brief: Type.Optional(Type.String()),
      ...sharedFields,
    },
    { additionalProperties: false },
  );

  const exec = async (p: Record<string, any>, pctx: PiToolExecuteCtx) => {
    const ui = pctx.hasUI ? pctx.ui : undefined;
    const configDefaults = await resolveCtxDefaults(ui);
    const toolUi = effectiveUi(ui, configDefaults);
    const shouldPush = async (): Promise<boolean> => {
      if (!toolUi) return false;
      return (await toolUi.confirm("Push followup?", "Push commit to remote now?")) === true;
    };
    const selectFromAmbiguous = async (candidates: string[]) => {
      if (!toolUi) return undefined;
      return toolUi.select("Multiple plan folders found", candidates);
    };
    const repoRoot = process.cwd();
    const runtime = resolveRuntime({ prompt: { aiPlanPath: p.aiPlanPath, gitMode: p.gitMode, tddMode: p.tddMode }, defaults: configDefaults, repoRoot });
    const result = await handler(
      {
        title: p.title,
        resume: p.resume,
        brief: p.brief,
        parentPlan: p.parentPlan,
        allowDirty: p.allowDirty,
        maxRounds: p.maxRounds,
        verification: p.verification,
        shouldPush,
        selectFromAmbiguous,
      },
      { repoRoot, signal: pctx.signal ?? undefined, ui: toolUi, configDefaults, toolName: pctx.toolName, planRoot: runtime.planRoot, gitMode: runtime.gitMode, tddMode: runtime.tddMode, rawGitMode: runtime.raw.gitMode, rawTddMode: runtime.raw.tddMode },
    );
    return {
      content: [
        {
          type: "text",
          text: appendCostSentence(`sf_team_followup: ${result.approved ? "approved" : "not approved"}; slug=${result.slug}; commit=${result.commitSha ?? "(none)"}; pushed=${result.pushed}; pr-description=${result.prDescriptionPath ?? "(none)"}; performance=${result.performanceReportPath ?? "(none)"}`, result),
        },
      ],
      details: result,
    };
  };

  const wrapped = wrapExecute<Record<string, any>, ToolExecuteOutcome<SfTeamTaskResult>>("sf_team_followup", async (_id, params, signal, _onUpdate, ctx) => {
    return exec(params, makeExecCtx("sf_team_followup", signal, ctx));
  });

  pi.registerTool({
    name: "sf_team_followup",
    label: "sf_team_followup",
    description: withCostSummaryGuidance(
      teamDeprecatedDescriptionPrefix("sf_team_followup") +
      "Draft and implement a follow-up to a completed plan. Creates a new plan folder under `ai_plan/<date>-followup-<slug>/` (e.g. `ai_plan/2026-05-08-followup-better-anim/`). The parent plan is referenced in the planner brief and recorded in `.pi/sf/agent-workflows/workflow.json` as `parentSlug` for resume; the parent folder is not modified. Runs in the current branch (same as `sf_team_task`); switch branches before invoking if a fresh branch is required. Required: `title`.",
    ),
    parameters: startSchema as any,
    execute: (id, params, signal, onUpdate, ctx) =>
      runExec(wrapped(id, params as Record<string, any>, signal ?? undefined, onUpdate ?? undefined, ctx)).then((r) => prependTeamDeprecationNotice("sf_team_followup", r)),
  });
}
