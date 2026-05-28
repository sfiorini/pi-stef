/**
 * Typed errors for the sf-team extension. The Pi runtime
 * (`@earendil-works/pi-agent-core@0.74.0`, `dist/agent-loop.js:367,390,418`)
 * builds a tool-result event from a thrown error by calling
 * `createErrorToolResult(error.message)` with `details: {}` BEFORE any
 * `tool_result` hook fires (verified inline in agent-loop.js:428-433). So
 * typed-error fields do NOT survive the throw — `Error.message` is the
 * sole user-facing channel.
 *
 * Therefore `SfTeamToolError`'s constructor composes the FULL user-facing
 * payload into `Error.message`:
 *   `FAILED: <toolName> <kind>: <description>. RESUME: <resumeHint>.`
 * The runtime's tool-result content text is exactly that message, so
 * calling LLMs cannot misread an empty-diff / legacy-alias / merge-failed
 * throw as a successful turn.
 *
 * `withTool(...)` returns a NEW instance OF THE SAME SUBCLASS with
 * overridden `toolName` / `resumeTool` (R3 P2 — no in-place mutation of
 * an already-thrown error; the new instance's message is recomposed by
 * the subclass constructor with the new fields). Used by `auto.ts` to
 * reframe an `EmptyDiffError` thrown from `implement` as one originating
 * from `sf_team_auto`.
 *
 * For internal logging where typed details DO survive (i.e., before the
 * throw crosses the runtime boundary), each error site records its full
 * structured details to the transcript via `ctx.transcript.record(...)`.
 */

export interface SfTeamToolErrorOptions {
  toolName: string;
  kind: string;
  description: string;
  resumeHint: string;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Tool to invoke to resume — typically `<base>_resume`. */
  resumeTool?: string;
  /**
   * Override the default `FAILED: <toolName> <kind>: <description>. RESUME:
   * <resumeHint>.` format. Reserved for subclasses that need a different
   * leading phrase. (Historical user: `LegacyAliasError`, removed once
   * the deprecated `sf_team_<base>` aliases were dropped from the
   * registration surface.)
   */
  messageOverride?: string;
}

interface CloneOverrides {
  toolName: string;
  details: Record<string, unknown>;
  resumeTool?: string;
  resumeHint: string;
}

export class SfTeamToolError extends Error {
  readonly toolName: string;
  readonly kind: string;
  readonly description: string;
  readonly details: Record<string, unknown>;
  readonly resumeHint: string;
  readonly resumeTool?: string;

  constructor(opts: SfTeamToolErrorOptions) {
    super(opts.messageOverride ?? composeSfTeamMessage(opts));
    this.name = this.constructor.name;
    this.toolName = opts.toolName;
    this.kind = opts.kind;
    this.description = opts.description;
    this.details = opts.details ?? {};
    this.resumeHint = opts.resumeHint;
    this.resumeTool = opts.resumeTool;
    if (opts.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: opts.cause, enumerable: false, writable: true });
    }
  }

  /**
   * Returns a NEW instance OF THE SAME SUBCLASS with `toolName` and
   * (optionally) `resumeTool` replaced. The new instance's `Error.message`
   * is recomposed via the subclass constructor with the new fields, so
   * the leading `FAILED: <toolName>` line reflects the new tool while
   * subclass-specific fields (e.g. `EmptyDiffError.attempts`,
   * `EmptyPlanError.rawPayload`) are preserved.
   *
   * Subclasses must override `cloneWithOverrides` to construct their own
   * subclass; the default implementation in this base class returns a
   * base `SfTeamToolError`, which is correct for subclasses that have no
   * additional state of their own (e.g. `WorkflowStateError`).
   *
   * The original instance is unchanged. (R3 P2 fix: `Error.message` is
   * built in the constructor and cannot be mutated post-throw.)
   */
  withTool(toolName: string, resumeTool?: string, extraDetails: Record<string, unknown> = {}): SfTeamToolError {
    const newDetails = { ...this.details, ...extraDetails };
    const newResumeTool = resumeTool ?? this.resumeTool;
    const newResumeHint = newResumeTool ? this.composeResumeHintWith(newResumeTool, newDetails) : this.resumeHint;
    return this.cloneWithOverrides({
      toolName,
      details: newDetails,
      resumeTool: newResumeTool,
      resumeHint: newResumeHint,
    });
  }

  /**
   * Hook used by `withTool` to construct a new instance of the receiver's
   * concrete subclass. Subclasses with required constructor fields
   * (EmptyDiffError, MergeFailedError, EmptyPlanError, …) override to
   * call their own constructor with the merged details. The base
   * implementation returns a fresh `SfTeamToolError` — correct for
   * subclasses with no extra state (`WorkflowStateError`).
   */
  protected cloneWithOverrides(overrides: CloneOverrides): SfTeamToolError {
    return new SfTeamToolError({
      toolName: overrides.toolName,
      kind: this.kind,
      description: this.description,
      resumeHint: overrides.resumeHint,
      resumeTool: overrides.resumeTool,
      details: overrides.details,
      cause: (this as Error & { cause?: unknown }).cause,
    });
  }

  /**
   * Subclasses override this to provide kind-specific resume instructions
   * (e.g., suggest the empty_diff_retry_model knob for EmptyDiffError).
   * Default form: `invoke <resumeTool> { resume: '<slug>' }` (or
   * `invoke <resumeTool>` when no slug is recorded in details).
   */
  protected composeResumeHintWith(resumeTool: string, details: Record<string, unknown>): string {
    const slug = typeof details.slug === "string" ? details.slug : undefined;
    return slug
      ? `invoke ${resumeTool} { resume: '${slug}' }`
      : `invoke ${resumeTool}`;
  }
}

function composeSfTeamMessage(
  opts: Pick<SfTeamToolErrorOptions, "toolName" | "kind" | "description" | "resumeHint">,
): string {
  return `FAILED: ${opts.toolName} ${opts.kind}: ${opts.description}. RESUME: ${opts.resumeHint}.`;
}

/**
 * Replace the `details` property on a freshly cloned subclass instance.
 * The constructor seeds only the subclass's canonical fields, so merged
 * extras passed via `withTool({...}, extraDetails)` would otherwise be
 * lost. This helper writes the FULL merged details map onto the new
 * instance, preserving the contract that `withTool` returns a clone with
 * "all the same details plus the supplied overrides" (S-M21 / S-M26).
 */
function overwriteDetails(target: SfTeamToolError, details: Record<string, unknown>): void {
  Object.defineProperty(target, "details", {
    value: details,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

export interface EmptyDiffErrorOptions {
  toolName: string;
  milestoneId: string;
  storyId?: string;
  attempts: number;
  slug: string;
  worktreePath?: string;
  /** Tool to invoke to resume — `sf_team_implement_resume` or `sf_team_auto_resume`. */
  resumeTool: string;
  cause?: unknown;
}

/**
 * Thrown when the developer agent stages no changes after the bounded
 * retry loop in `implement.ts:reviewMilestoneChanges` (M3) exhausts its
 * attempts. The composed message names the milestone, the attempt count,
 * and points at the right `_resume` tool plus the configurable model
 * bump knob.
 */
export class EmptyDiffError extends SfTeamToolError {
  constructor(opts: EmptyDiffErrorOptions) {
    const description = formatEmptyDiffDescription({
      milestoneId: opts.milestoneId,
      storyId: opts.storyId,
      attempts: opts.attempts,
    });
    const resumeHint = formatEmptyDiffResumeHint(opts.resumeTool, opts.slug);
    super({
      toolName: opts.toolName,
      kind: "empty_diff",
      description,
      resumeHint,
      resumeTool: opts.resumeTool,
      details: {
        milestoneId: opts.milestoneId,
        storyId: opts.storyId,
        attempts: opts.attempts,
        slug: opts.slug,
        worktreePath: opts.worktreePath,
      },
      cause: opts.cause,
    });
  }

  protected override composeResumeHintWith(resumeTool: string, details: Record<string, unknown>): string {
    const slug = typeof details.slug === "string" ? details.slug : "<slug>";
    return formatEmptyDiffResumeHint(resumeTool, slug);
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): EmptyDiffError {
    const d = overrides.details;
    const cloned = new EmptyDiffError({
      toolName: overrides.toolName,
      milestoneId: typeof d.milestoneId === "string" ? d.milestoneId : "unknown",
      storyId: typeof d.storyId === "string" ? d.storyId : undefined,
      attempts: typeof d.attempts === "number" ? d.attempts : 1,
      slug: typeof d.slug === "string" ? d.slug : "<slug>",
      worktreePath: typeof d.worktreePath === "string" ? d.worktreePath : undefined,
      resumeTool: overrides.resumeTool ?? this.resumeTool ?? "sf_team_implement_resume",
      cause: (this as Error & { cause?: unknown }).cause,
    });
    // Constructor only seeds canonical fields into `details`; preserve any
    // merged extras (e.g. auto's `autoSlug`) so the typed error retains the
    // full picture before the runtime boundary drops fields.
    overwriteDetails(cloned, overrides.details);
    return cloned;
  }
}

function formatEmptyDiffDescription(opts: {
  milestoneId: string;
  storyId?: string;
  attempts: number;
}): string {
  const target = opts.storyId ? `${opts.milestoneId}/${opts.storyId}` : opts.milestoneId;
  const attemptsWord = opts.attempts === 1 ? "attempt" : "attempts";
  return `milestone ${target} produced no changes after ${opts.attempts} ${attemptsWord}`;
}

function formatEmptyDiffResumeHint(resumeTool: string, slug: string): string {
  return (
    `invoke ${resumeTool} { resume: '${slug}' } and consider setting ` +
    "`implement.empty_diff_retry_model` to a stronger model in ~/.pi/sf-team/config.json"
  );
}

export interface MergeFailedErrorOptions {
  toolName: string;
  lane: string;
  branch: string;
  mergeTarget: string;
  status: string;
  stderr?: string;
  stdout?: string;
  resumeTool?: string;
  slug?: string;
  cause?: unknown;
}

/**
 * Thrown by parallel rollup when `git merge` of a lane branch into its
 * parent target fails. Carries enough context to retry manually.
 */
export class MergeFailedError extends SfTeamToolError {
  constructor(opts: MergeFailedErrorOptions) {
    const description =
      `merge of ${opts.lane} (${opts.branch}) into ${opts.mergeTarget} reported status=${opts.status}`;
    const resumeHint = opts.resumeTool && opts.slug
      ? `inspect the worktree, resolve the merge, then invoke ${opts.resumeTool} { resume: '${opts.slug}' }`
      : "inspect the worktree and resolve the merge before retrying";
    super({
      toolName: opts.toolName,
      kind: "merge_failed",
      description,
      resumeHint,
      resumeTool: opts.resumeTool,
      details: {
        lane: opts.lane,
        branch: opts.branch,
        mergeTarget: opts.mergeTarget,
        status: opts.status,
        stderr: opts.stderr,
        stdout: opts.stdout,
        slug: opts.slug,
      },
      cause: opts.cause,
    });
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): MergeFailedError {
    const d = overrides.details;
    const cloned = new MergeFailedError({
      toolName: overrides.toolName,
      lane: typeof d.lane === "string" ? d.lane : "unknown",
      branch: typeof d.branch === "string" ? d.branch : "unknown",
      mergeTarget: typeof d.mergeTarget === "string" ? d.mergeTarget : "unknown",
      status: typeof d.status === "string" ? d.status : "unknown",
      stderr: typeof d.stderr === "string" ? d.stderr : undefined,
      stdout: typeof d.stdout === "string" ? d.stdout : undefined,
      resumeTool: overrides.resumeTool ?? this.resumeTool,
      slug: typeof d.slug === "string" ? d.slug : undefined,
      cause: (this as Error & { cause?: unknown }).cause,
    });
    overwriteDetails(cloned, overrides.details);
    return cloned;
  }
}

export interface WorkflowStateErrorOptions {
  toolName: string;
  description: string;
  resumeHint?: string;
  details?: Record<string, unknown>;
  resumeTool?: string;
  cause?: unknown;
}

/**
 * Generic wrapper for "the workflow encountered a state we cannot
 * recover from in this turn" — used by sweeps in plan/task/followup that
 * convert legacy `throw new Error(...)` sites whose semantics don't fit
 * a more specific subclass.
 */
export class WorkflowStateError extends SfTeamToolError {
  constructor(opts: WorkflowStateErrorOptions) {
    super({
      toolName: opts.toolName,
      kind: "workflow_state",
      description: opts.description,
      resumeHint: opts.resumeHint ?? "Consult the sf-team transcript under ai_plan/<slug>/ for details",
      details: opts.details,
      resumeTool: opts.resumeTool,
      cause: opts.cause,
    });
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): WorkflowStateError {
    // WorkflowStateError already accepts arbitrary `details` in its
    // constructor, so passing `overrides.details` directly is enough —
    // overwriteDetails would be a no-op here. Constructor preserves the
    // full merged map.
    return new WorkflowStateError({
      toolName: overrides.toolName,
      description: this.description,
      resumeHint: overrides.resumeHint,
      details: overrides.details,
      resumeTool: overrides.resumeTool,
      cause: (this as Error & { cause?: unknown }).cause,
    });
  }
}

export interface ConfigLoadErrorOptions {
  toolName: string;
  configPath: string;
  reason: string;
  resumeHint?: string;
  cause?: unknown;
}

/**
 * Thrown when a config file fails to load (parse error, IO error, schema
 * mismatch). Surface includes the path so the user can find and fix the
 * file. `loadAndResolveDefaults` currently uses `ui.notify` for warnings
 * and falls back to defaults, but a fatal config-load path can throw
 * this class.
 */
export class ConfigLoadError extends SfTeamToolError {
  readonly configPath: string;
  readonly reason: string;

  constructor(opts: ConfigLoadErrorOptions) {
    super({
      toolName: opts.toolName,
      kind: "config_load",
      description: `cannot load config at ${opts.configPath}: ${opts.reason}`,
      resumeHint: opts.resumeHint ?? `fix or remove ${opts.configPath}, then re-invoke`,
      details: { configPath: opts.configPath, reason: opts.reason },
      cause: opts.cause,
    });
    this.configPath = opts.configPath;
    this.reason = opts.reason;
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): ConfigLoadError {
    const cloned = new ConfigLoadError({
      toolName: overrides.toolName,
      configPath: this.configPath,
      reason: this.reason,
      resumeHint: overrides.resumeHint,
      cause: (this as Error & { cause?: unknown }).cause,
    });
    overwriteDetails(cloned, overrides.details);
    return cloned;
  }
}

export interface LaneCleanupErrorOptions {
  toolName: string;
  lane: string;
  branch: string;
  reason: string;
  resumeHint?: string;
  cause?: unknown;
}

/**
 * Thrown when lane-branch cleanup hits an unrecoverable error during
 * post-rollup teardown. M4's `tryDeleteBranch` favors RECORDING warnings
 * (BranchCleanupWarning) over throwing — so this class is reserved for
 * cases where cleanup must abort the run rather than degrade to a
 * warning.
 */
export class LaneCleanupError extends SfTeamToolError {
  readonly lane: string;
  readonly branch: string;
  readonly reason: string;

  constructor(opts: LaneCleanupErrorOptions) {
    super({
      toolName: opts.toolName,
      kind: "lane_cleanup",
      description: `lane ${opts.lane} (${opts.branch}) cleanup failed: ${opts.reason}`,
      resumeHint: opts.resumeHint ?? `inspect ${opts.branch}, clean up manually, then re-invoke`,
      details: { lane: opts.lane, branch: opts.branch, reason: opts.reason },
      cause: opts.cause,
    });
    this.lane = opts.lane;
    this.branch = opts.branch;
    this.reason = opts.reason;
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): LaneCleanupError {
    const cloned = new LaneCleanupError({
      toolName: overrides.toolName,
      lane: this.lane,
      branch: this.branch,
      reason: this.reason,
      resumeHint: overrides.resumeHint,
      cause: (this as Error & { cause?: unknown }).cause,
    });
    overwriteDetails(cloned, overrides.details);
    return cloned;
  }
}

// ---------------------------------------------------------------------------
// New typed errors for no-git mode and configurable plan-root (D21 + D25)
// ---------------------------------------------------------------------------

/** Thrown when the aiPlanPath / paths.ai_plan_root cannot be resolved to an absolute path. */
export class PlanRootResolutionError extends SfTeamToolError {}

/** Thrown when recursive mkdir of the plan root directory fails (e.g., EACCES). */
export class PlanRootCreationError extends SfTeamToolError {}

/** Thrown when a prompt arg (aiPlanPath / gitMode / tddMode) conflicts with the persisted workflow.json value on resume. */
export class WorkflowMetadataConflictError extends SfTeamToolError {}

/** Thrown when mutually exclusive options are supplied (e.g., useWorktree=true + gitMode='off'). */
export class IncompatibleModeError extends SfTeamToolError {}

// ---------------------------------------------------------------------------
// Boundary helper: typed-error converter
// ---------------------------------------------------------------------------

/**
 * Pi-style `execute` signature that sf-team tools expose to the runtime:
 * `(id, params, signal, onUpdate, ctx) => Promise<TResult>`. `wrapExecute`
 * preserves this signature exactly so the wrapped function can be
 * registered directly with `pi.registerTool({ execute })`.
 */
export type SfTeamExecuteFn<TParams, TResult> = (
  id: string,
  params: TParams,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
) => Promise<TResult>;

/**
 * Map a registered Pi tool name (`sf_team_auto`, `sf_team_auto_resume`,
 * etc.) to the matching `_resume` tool name. Used by `wrapExecute` to
 * compose a resume hint that names the recovery tool directly instead of
 * the generic transcript-only copy. Returns `undefined` for unrecognized
 * names so callers can fall back to the generic hint without conjuring
 * fake tool names. Both `sf_team_<base>` (start) and
 * `sf_team_<base>_resume` map to `sf_team_<base>_resume`.
 */
function resolveResumeToolForBoundary(toolName: string): string | undefined {
  const KNOWN_BASES = [
    "sf_team_plan",
    "sf_team_implement",
    "sf_team_task",
    "sf_team_auto",
    "sf_team_followup",
  ] as const;
  for (const base of KNOWN_BASES) {
    if (toolName === base || toolName === `${base}_resume`) {
      return `${base}_resume`;
    }
  }
  return undefined;
}

/**
 * Wraps a tool-execute body so any non-`SfTeamToolError` throw is
 * converted to `SfTeamToolError({ kind: "internal", ... })` whose
 * `Error.message` carries the `FAILED: <toolName> internal: ...` envelope.
 * Already-typed errors (`SfTeamToolError` and its subclasses) pass through
 * unchanged.
 *
 * This is NOT a swallow — every throw becomes another throw. The wrapper's
 * sole job is to guarantee the outgoing `Error.message` is structured.
 *
 * Resume hint: when `toolName` is a recognized sf-team base or `_resume`
 * tool, the hint names the matching `_resume` tool directly (with a
 * `<slug-or-path>` placeholder, since the real slug is set inside the
 * inner handler and is not available at the boundary). Unknown tool
 * names fall back to a generic transcript-only line. Calling LLMs that
 * had to infer the resume tool from context now get an explicit pointer
 * in the failure envelope.
 *
 * Streaming `_onUpdate` callbacks are NOT wrapped — no sf-team tool
 * currently emits partial updates (R2 P3).
 */
export function wrapExecute<TParams, TResult>(
  toolName: string,
  fn: SfTeamExecuteFn<TParams, TResult>,
): SfTeamExecuteFn<TParams, TResult> {
  return async (id, params, signal, onUpdate, ctx) => {
    try {
      return await fn(id, params, signal, onUpdate, ctx);
    } catch (err) {
      if (err instanceof SfTeamToolError) throw err;
      const stringifiedCause = err instanceof Error ? err.message : String(err);
      const resumeTool = resolveResumeToolForBoundary(toolName);
      const resumeHint = resumeTool
        ? `invoke ${resumeTool} { resume: '<slug-or-path>' } to retry from saved state, or consult the sf-team transcript under ai_plan/<slug>/ for details`
        : "Consult the sf-team transcript under ai_plan/<slug>/ for details";
      throw new SfTeamToolError({
        toolName,
        kind: "internal",
        description: stringifiedCause,
        resumeHint,
        resumeTool,
        details: { stringifiedCause },
        cause: err,
      });
    }
  };
}
