import { SfTeamToolError } from "../errors";

interface CloneOverrides {
  toolName: string;
  details: Record<string, unknown>;
  resumeTool?: string;
  resumeHint: string;
}

/**
 * Thrown by `sf_team_plan` when the reviewer-approved plan body fails any of
 * the three structural validators (length, real milestones, real stories).
 *
 * Carries the raw planner output so diagnostics can replay what was rejected.
 * `reason` enumerates which validator failed first; multiple failures still
 * surface a single reason because we report the first miss.
 *
 * Extends `SfTeamToolError` so its `Error.message` is composed as
 * `FAILED: <toolName> empty_plan: <reason>. RESUME: ...` — calling LLMs
 * see the structured envelope through the Pi runtime even though typed
 * fields are dropped (`agent-loop.js:367,390,418`).
 */
export type EmptyPlanReason = "no-milestones" | "no-stories" | "too-short";

export interface EmptyPlanErrorOptions {
  rawPayload: string;
  reason: EmptyPlanReason;
  diagnosticsPath?: string;
  /** Pi tool surface name (`sf_team_plan` / `sf_team_auto` / …). */
  toolName?: string;
  /** Slug used for the `RESUME: invoke <resumeTool> { resume: '...' }` hint. */
  slug?: string;
  /** `_resume` tool to recommend; defaults to `sf_team_plan_resume`. */
  resumeTool?: string;
}

export class EmptyPlanError extends SfTeamToolError {
  readonly rawPayload: string;
  readonly reason: EmptyPlanReason;
  readonly diagnosticsPath?: string;

  constructor(opts: EmptyPlanErrorOptions) {
    const toolName = opts.toolName ?? "sf_team_plan";
    const resumeTool = opts.resumeTool ?? "sf_team_plan_resume";
    const slug = opts.slug;
    const description = `Planner output failed plan-shape validation: ${opts.reason}`;
    const resumeHint = slug
      ? `invoke ${resumeTool} { resume: '${slug}' } and consider rephrasing the brief or supplying more context`
      : `invoke ${resumeTool} { resume: '<slug>' } and consider rephrasing the brief or supplying more context`;
    super({
      toolName,
      kind: "empty_plan",
      description,
      resumeHint,
      resumeTool,
      details: {
        reason: opts.reason,
        rawPayloadBytes: opts.rawPayload.length,
        diagnosticsPath: opts.diagnosticsPath,
        slug,
      },
    });
    this.rawPayload = opts.rawPayload;
    this.reason = opts.reason;
    this.diagnosticsPath = opts.diagnosticsPath;
  }

  toJSON(): {
    name: string;
    message: string;
    reason: EmptyPlanReason;
    rawPayloadBytes: number;
    diagnosticsPath?: string;
  } {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      rawPayloadBytes: this.rawPayload.length,
      diagnosticsPath: this.diagnosticsPath,
    };
  }

  protected override cloneWithOverrides(overrides: CloneOverrides): EmptyPlanError {
    const d = overrides.details;
    const cloned = new EmptyPlanError({
      rawPayload: this.rawPayload,
      reason: this.reason,
      diagnosticsPath: this.diagnosticsPath,
      toolName: overrides.toolName,
      slug: typeof d.slug === "string" ? d.slug : undefined,
      resumeTool: overrides.resumeTool,
    });
    Object.defineProperty(cloned, "details", {
      value: overrides.details,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    return cloned;
  }
}
