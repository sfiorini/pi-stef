import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { SfTeamToolError, WorkflowStateError } from "../errors";
import { createSfTeamPlan, type AgentSettingsDetails, type AgentSettingsSource, type SfTeamPlanInput, type SfTeamPlanResult, type ResearcherDecision } from "./plan";
import { createSfTeamImplement, type SfTeamImplementInput, type SfTeamImplementResult } from "./implement";
import { DEFAULT_CONFIG } from "../config/schema";
import { effectiveUi, isHeadlessWorkflow } from "../config/workflow";
import { PLAN_FOLDER_ROOT, planFolderPathFromRoot } from "../plan/paths";
import type { AgentRole } from "../runtime/types";
import { getActiveSession, TmuxManager } from "../tmux/manager";
import { requireGitOrSkip } from "../worktree/validate";
import { readImplementPlanFolder, type PlanFolderRead } from "./implement-reader";
import { normalOrResumeValue, resolveToolResume } from "./resume";
import { defaultDeps, type ToolDeps } from "./shared";
import { verificationDefaultsForAutoImplement, verificationDefaultsForPlanPhase, type SfTeamVerificationConfigInput } from "./verification-stage";
import type { CostSummary } from "../orchestrator/cost";

/**
 * Probe tmux ONCE for the next-available `sf_team_auto-N` alias. Used
 * by `sf_team_auto` so its plan + implement nested orchestrator runs
 * land on the same session instead of fighting over `sf_team_plan-1`
 * vs `sf_team_implement-1`. Returns `undefined` outside of tmux or
 * when probing fails (the orchestrator will then fall back to its
 * per-tool default).
 */
function resolveAutoSessionAlias(): string | undefined {
  try {
    if (!getActiveSession()) return undefined;
    return new TmuxManager().nextSessionAlias("sf_team_auto");
  } catch {
    return undefined;
  }
}

export interface SfTeamAutoInput {
  /** Title for the new plan + brief for the planner. */
  title?: string;
  resume?: string;
  brief?: string;
  maxRounds?: number;
  /** Override implement-phase verifyCommand (false skips). */
  verifyCommand?: SfTeamImplementInput["verifyCommand"];
  verification?: SfTeamVerificationConfigInput;
  /** Branch prefix for the new branch (default 'auto/'). */
  branchPrefix?: string;
  /**
   * Inter-milestone pause. Defaults to `ctx.configDefaults?.auto.pause_between_milestones`
   * (which itself defaults to `false` so end-to-end auto runs do not stop).
   * Set to `true` to make the auto run prompt between milestones.
   */
  pauseBetweenMilestones?: boolean;
}

export interface SfTeamAutoResult {
  slug: string;
  planRounds: number;
  implement: SfTeamImplementResult;
  agentSettings: AgentSettingsDetails;
  researcherDecision: ResearcherDecision;
  performanceReportPaths: string[];
  costSummary?: CostSummary;
}

/**
 * sf_team_auto: chains sf_team_plan and sf_team_implement (D2 default).
 * No human gates between — runs end-to-end. Still asks before push (the
 * implement tool's pr-description doesn't push).
 */
export function createSfTeamAuto(rawDeps: Partial<ToolDeps> = {}) {
  const deps: ToolDeps = { ...defaultDeps, ...rawDeps };
  const planTool = createSfTeamPlan(deps);
  const implementTool = createSfTeamImplement(deps);

  return async function sfTeamAuto(
    input: SfTeamAutoInput,
    ctx: {
      repoRoot: string;
      signal?: AbortSignal;
      ui?: ExtensionUIContext;
      configDefaults?: import("../config/schema").ResolvedDefaults;
      /**
       * Pi tool name (`sf_team_auto` or `sf_team_auto_resume`) fronting
       * this run. Used by typed errors so the `FAILED:` envelope names
       * the auto surface, not the inner implement surface, when
       * implement-side errors propagate up.
       */
      toolName?: string;
      /** When 'off', skip all git operations (no worktree, no commit, no PR). */
      gitMode?: "on" | "off";
      tddMode?: "on" | "off" | "auto";
      /** Resolved planRoot for resume discovery cascade. */
      planRoot?: string;
      /** Raw prompt value for gitMode before runtime resolution; used for resume precedence. */
      rawGitMode?: "auto" | "on" | "off";
      /** Raw prompt value for tddMode before runtime resolution; used for resume precedence. */
      rawTddMode?: "auto" | "on" | "off";
    },
  ): Promise<SfTeamAutoResult> {
    const autoToolName = ctx.toolName ?? "sf_team_auto";
    const autoResumeTool = "sf_team_auto_resume";
    // Preflight: auto chains plan + implement; the implement phase WILL
    // create a worktree and commit in git mode. Fail fast here BEFORE
    // the planner runs so the user doesn't burn a full plan-review loop
    // against a non-git folder. In no-git mode, skip this check.
    const resume = await resolveToolResume({
      repoRoot: ctx.repoRoot,
      toolName: "sf_team_auto",
      input,
      normalField: "title",
      candidatePlanRoots: ctx.planRoot ? [ctx.planRoot] : undefined,
    });
    // Resume precedence: persisted gitMode/tddMode wins over auto-detected values.
    const effectiveGitMode: "on" | "off" =
      resume?.metadata?.gitMode != null && (ctx.rawGitMode === undefined || ctx.rawGitMode === "auto")
        ? resume.metadata.gitMode
        : (ctx.gitMode ?? "on");
    const effectiveTddMode: "on" | "off" | "auto" =
      resume?.metadata?.tddMode != null && (ctx.rawTddMode === undefined || ctx.rawTddMode === "auto")
        ? resume.metadata.tddMode
        : (ctx.tddMode ?? "auto");
    // effectivePlanRoot: prefer resume metadata's planRootPath (set when plan found via
    // global index or external candidatePlanRoots) over the prompt-resolved ctx.planRoot.
    const effectivePlanRoot = resume?.metadata?.planRootPath ?? ctx.planRoot;
    // Preflight git check after effective mode resolution so a slug-only resume
    // from a non-git cwd of a no-git workflow uses the persisted gitMode='off'.
    requireGitOrSkip({ repoRoot: ctx.repoRoot, gitMode: effectiveGitMode }, "sf_team_auto");
    const title = normalOrResumeValue(input, "title", resume);
    // Resolve a shared `sf_team_auto-N` alias up front so the plan and
    // implement phases decorate the SAME tmux session. Without this,
    // each phase would alias the launcher session under its own
    // toolName (`sf_team_plan-1`, `sf_team_implement-1`), and the
    // implement phase would fail to find the session it inherited
    // from the plan phase.
    const tmuxSessionAliasOverride = isHeadlessWorkflow(ctx.configDefaults) ? undefined : resolveAutoSessionAlias();
    const innerCtx = {
      ...ctx,
      ui: effectiveUi(ctx.ui, ctx.configDefaults),
      tmuxSessionAliasOverride,
      resumeOwnerTool: "sf_team_auto" as const,
      gitMode: effectiveGitMode,
      tddMode: effectiveTddMode,
      planRoot: effectivePlanRoot,
    };
    const baseDefaults = ctx.configDefaults ?? DEFAULT_CONFIG;

    const resumeSlug = resume?.target.slug;
    const resumePlanFolder = resumeSlug
      ? await readResumeImplementPlanFolder(ctx.repoRoot, resumeSlug, resume.metadata?.currentTool, autoToolName, effectivePlanRoot)
      : undefined;
    const planInput: SfTeamPlanInput = resume && !resumePlanFolder
      ? { resume: resume.target.slug, maxRounds: input.maxRounds }
      : { title, brief: input.brief, maxRounds: input.maxRounds };
    const plan = resumePlanFolder
      ? resumedPlanSummary(resumePlanFolder, baseDefaults, ctx.configDefaults !== undefined)
      : await planTool(planInput, {
        ...innerCtx,
        configDefaults: verificationDefaultsForPlanPhase(baseDefaults, { invokedByAuto: true }),
        suppressPlanVerification: true,
      });
    const implementInput: Pick<SfTeamImplementInput, "resume" | "slug"> = resumePlanFolder
      ? { resume: plan.slug }
      : { slug: plan.slug };
    let implement: SfTeamImplementResult;
    try {
      implement = await implementTool(
        {
          ...implementInput,
          maxRounds: input.maxRounds,
          mode: ctx.configDefaults?.auto.mode ?? "all-milestones",
          branchPrefix: input.branchPrefix ?? ctx.configDefaults?.auto.branch_prefix ?? "auto/",
          useWorktree: ctx.configDefaults?.auto.use_worktree,
          // For sf_team_auto we resolve from `auto.*` rather than `implement.*`.
          // Falling through to `auto`'s default (false) keeps the headless
          // "run end-to-end" behavior unless the user explicitly opts in.
          // Explicit final fallback to DEFAULT_CONFIG.auto.* so that callers
          // without a configDefaults object still get the auto default
          // (false) and don't accidentally inherit implement's default (true).
          pauseBetweenMilestones:
            input.pauseBetweenMilestones
              ?? ctx.configDefaults?.auto.pause_between_milestones
              ?? DEFAULT_CONFIG.auto.pause_between_milestones,
          verifyCommand: input.verifyCommand,
          verification: input.verification,
        },
        {
          ...innerCtx,
          configDefaults: verificationDefaultsForAutoImplement(baseDefaults, input.verification),
          // The implement surface is always `sf_team_implement` (the
          // bare base name; the historical `_start` suffix was dropped
          // in the M1-collapse follow-up). Auto's outer try/catch
          // rewraps any SfTeamToolError via `withTool(...)` so the
          // user-facing FAILED:/RESUME: line names the auto surface and
          // points at `sf_team_auto_resume`. (R3 P2: no post-throw
          // mutation of `Error.message`.)
          toolName: "sf_team_implement",
        },
      );
    } catch (err) {
      if (err instanceof SfTeamToolError) {
        throw err.withTool(autoToolName, autoResumeTool, { autoSlug: plan.slug, slug: plan.slug });
      }
      throw err;
    }
    return {
      slug: plan.slug,
      planRounds: plan.rounds,
      implement,
      agentSettings: plan.agentSettings,
      researcherDecision: plan.researcherDecision,
      performanceReportPaths: [plan.performanceReportPath, implement.performanceReportPath]
        .filter((value): value is string => !!value),
      costSummary: implement.costSummary ?? plan.costSummary,
    };
  };
}

async function readResumeImplementPlanFolder(
  repoRoot: string,
  slug: string,
  currentTool: import("@pi-stef/agent-workflows").WorkflowToolName | undefined,
  autoToolName: string,
  planRoot?: string,
): Promise<PlanFolderRead | undefined> {
  const resolvedPlanRoot = planRoot ?? path.join(repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const folder = planFolderPathFromRoot(resolvedPlanRoot, slug);
  try {
    const folderStat = await stat(folder);
    if (!folderStat.isDirectory()) {
      throw new WorkflowStateError({
        toolName: autoToolName,
        description: `resume target is not a directory: ${folder}`,
        resumeHint: `verify ${folder} exists as a plan folder, then retry`,
        details: { slug, folder },
      });
    }
  } catch (err) {
    if (err instanceof SfTeamToolError) throw err;
    if (errorCode(err) === "ENOENT") return undefined;
    throw new WorkflowStateError({
      toolName: autoToolName,
      description: `cannot inspect resume plan folder at ${folder}: ${errorMessage(err)}`,
      resumeHint: `confirm ${folder} is readable and retry`,
      details: { slug, folder },
      cause: err,
    });
  }

  try {
    return await readImplementPlanFolder(repoRoot, slug, planRoot);
  } catch (err) {
    if (errorCode(err) === "ENOENT" && currentTool === "sf_team_plan") {
      return undefined;
    }
    throw new WorkflowStateError({
      toolName: autoToolName,
      description: `cannot read implementable plan files at ${folder}; refusing to rerun planner on resume: ${errorMessage(err)}`,
      resumeHint: `inspect the plan folder under ${folder}, restore missing files, then retry`,
      details: { slug, folder },
      cause: err,
    });
  }
}

function resumedPlanSummary(
  folder: PlanFolderRead,
  config: import("../config/schema").ResolvedDefaults,
  fromResolvedConfig: boolean,
): SfTeamPlanResult {
  return {
    slug: folder.slug,
    approved: true,
    rounds: 0,
    finalPlan: folder.milestonePlan,
    folderPath: folder.folder,
    agentSettings: agentSettingsFromConfig(config, fromResolvedConfig),
    researcherDecision: {
      policy: config.performance.researcher,
      action: "skipped",
      reason: "auto resume bypassed the plan phase because the target already has an implementable plan folder; researcher was not consulted",
      externalRefs: 0,
      signals: [],
    },
    revisionMetrics: [],
  };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function agentSettingsFromConfig(
  config: import("../config/schema").ResolvedDefaults,
  fromResolvedConfig: boolean,
): AgentSettingsDetails {
  // Auto resume bypasses plan inputs, so every displayed setting comes from
  // either the resolved config object or the built-in defaults.
  const source: AgentSettingsSource = fromResolvedConfig ? "resolved-config" : "default";
  const describe = (role: AgentRole) => {
    const member = config.agents[role];
    return {
      model: member.model,
      thinking: member.thinking,
      heartbeatMs: member.heartbeatMs,
      source: {
        model: source,
        thinking: source,
        heartbeatMs: source,
      },
    };
  };
  return {
    planner: describe("planner"),
    reviewer: describe("reviewer"),
    developer: describe("developer"),
    researcher: describe("researcher"),
  };
}
