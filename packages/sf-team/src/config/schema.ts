import { Type, type Static } from "typebox";
import {
  VERIFICATION_CACHE_MODES,
  VERIFICATION_MODES,
  VERIFICATION_STAGE_NAMES,
  VERIFICATION_TIMINGS,
  type VerificationConfigInput,
} from "@pi-stef/agent-workflows";

export const GIT_MODES = ["auto", "on", "off"] as const;
export type GitMode = (typeof GIT_MODES)[number];

export const TDD_MODES = ["auto", "on", "off"] as const;
export type TddMode = (typeof TDD_MODES)[number];

export interface PathsConfig {
  ai_plan_root?: string;
  git_mode: GitMode;
}

export interface TddConfig {
  mode: TddMode;
}

const GitModeSchema = Type.Union(GIT_MODES.map((m) => Type.Literal(m)));
const TddModeSchema = Type.Union(TDD_MODES.map((m) => Type.Literal(m)));

const PathsConfigSchema = Type.Object(
  {
    ai_plan_root: Type.Optional(Type.String({ minLength: 1 })),
    git_mode: Type.Optional(GitModeSchema),
  },
  { additionalProperties: false },
);

const TddConfigSchema = Type.Object(
  {
    mode: Type.Optional(TddModeSchema),
  },
  { additionalProperties: false },
);

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));

const AgentSchema = Type.Object(
  {
    model: Type.Optional(Type.String({ minLength: 1, description: "Model id; supports provider/id and optional :<thinking> shorthand." })),
    thinking: Type.Optional(ThinkingLevelSchema),
    /**
     * Watchdog threshold in ms. The runtime kills the agent's process tree if
     * no stdout/stderr activity is observed for this long. Per-role defaults
     * live in {@link DEFAULT_CONFIG}: planner/researcher use 300_000 (5 min);
     * reviewer/developer use 600_000 (10 min) because high-thinking models can
     * reason silently for longer between events on large plans / multi-file
     * milestone turns. Override per call when a role legitimately needs more.
     */
    heartbeatMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

export const IMPLEMENT_MODES = ["single-milestone", "all-milestones"] as const;
export type ImplementMode = (typeof IMPLEMENT_MODES)[number];

const ImplementModeSchema = Type.Union(IMPLEMENT_MODES.map((mode) => Type.Literal(mode)));

export const RESEARCHER_POLICIES = ["auto", "always", "never"] as const;
export type ResearcherPolicy = (typeof RESEARCHER_POLICIES)[number];
const ResearcherPolicySchema = Type.Union(RESEARCHER_POLICIES.map((policy) => Type.Literal(policy)));

export const PLAN_REVISION_MODES = ["patch", "full"] as const;
export type PlanRevisionMode = (typeof PLAN_REVISION_MODES)[number];
const PlanRevisionModeSchema = Type.Union(PLAN_REVISION_MODES.map((mode) => Type.Literal(mode)));

export const WORKFLOW_PROFILES = ["default", "headless"] as const;
export type WorkflowProfile = (typeof WORKFLOW_PROFILES)[number];
const WorkflowProfileSchema = Type.Union(WORKFLOW_PROFILES.map((profile) => Type.Literal(profile)));

const WorkflowSchema = Type.Object(
  {
    /**
     * `headless` disables interactive side channels and applies faster
     * review defaults. Explicit review/UI knobs still win.
     */
    profile: Type.Optional(WorkflowProfileSchema),
  },
  { additionalProperties: false },
);

const VerificationTimingSchema = Type.Union(VERIFICATION_TIMINGS.map((timing) => Type.Literal(timing)));
const VerificationModeSchema = Type.Union(VERIFICATION_MODES.map((mode) => Type.Literal(mode)));
const VerificationCacheModeSchema = Type.Union(VERIFICATION_CACHE_MODES.map((mode) => Type.Literal(mode)));
const VerificationNamedStageSchema = Type.Union([
  ...VERIFICATION_STAGE_NAMES.map((stage) => Type.Literal(stage)),
  Type.Literal("all"),
]);
const VerificationCommandSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1 })),
    cmd: Type.String({ minLength: 1 }),
    args: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const VerificationStageItemSchema = Type.Union([VerificationNamedStageSchema, VerificationCommandSchema]);
const VerificationStagesSchema = Type.Union([VerificationStageItemSchema, Type.Array(VerificationStageItemSchema)]);
const VerificationCommandsSchema = Type.Union([VerificationCommandSchema, Type.Array(VerificationCommandSchema)]);
const VerificationCacheSchema = Type.Union([
  VerificationCacheModeSchema,
  Type.Object(
    {
      mode: VerificationCacheModeSchema,
      path: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);

export const VerificationConfigSchema = Type.Object(
  {
    timing: Type.Optional(VerificationTimingSchema),
    mode: Type.Optional(VerificationModeSchema),
    stages: Type.Optional(VerificationStagesSchema),
    commands: Type.Optional(VerificationCommandsSchema),
    cache: Type.Optional(VerificationCacheSchema),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    max_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

const PlanSchema = Type.Object(
  {
    verification: Type.Optional(VerificationConfigSchema),
  },
  { additionalProperties: false },
);

const ImplementSchema = Type.Object(
  {
    mode: Type.Optional(ImplementModeSchema),
    use_worktree: Type.Optional(Type.Boolean()),
    /** RESERVED — not yet honored by `createWorktree`. Reading this field is safe; setting it has no effect today. Track follow-up before relying on it. */
    create_branch: Type.Optional(
      Type.Boolean({
        description:
          "RESERVED — not yet honored by createWorktree. Setting this has no effect today; track follow-up before relying on it.",
      }),
    ),
    branch_prefix: Type.Optional(Type.String()),
    /**
     * When true, the orchestrator pauses after each milestone (commit + ask
     * the user to confirm before continuing). When false, milestones run
     * end-to-end without intervention. Headless mode (`!ctx.ui`) treats
     * `true` as `false` with a warning so test/CI runs do not hang.
     *
     * Defaults: `implement.pause_between_milestones=true` (interactive
     * single-milestone), `auto.pause_between_milestones=false` (run-through).
     */
    pause_between_milestones: Type.Optional(Type.Boolean()),
    /**
     * Number of times to re-prompt the developer agent if its first impl
     * attempt produced no staged changes. Default 2. Set to 0 to revert to
     * pre-M3 behavior (throw EmptyDiffError on first empty attempt).
     */
    empty_diff_retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    /**
     * When set, the LAST empty-diff retry passes this model to the developer
     * spawn helper instead of the configured developer model. Lets users
     * opt into a stronger model only on the final attempt to limit token
     * spend. When unset (default), no model bump occurs on any retry.
     */
    empty_diff_retry_model: Type.Optional(Type.String({ minLength: 1 })),
    verification: Type.Optional(VerificationConfigSchema),
  },
  { additionalProperties: false },
);

const TaskSchema = Type.Object(
  {
    /** RESERVED — task tools currently always edit the user's working tree. Setting this has no effect today; will skip baseline capture without creating a worktree if naively wired. */
    use_worktree: Type.Optional(
      Type.Boolean({
        description:
          "RESERVED — fh_team_task does not yet create a worktree. Setting this to true has no effect today; do not rely on it for isolation.",
      }),
    ),
    /** RESERVED — not yet honored by `createWorktree`. Reading this field is safe; setting it has no effect today. Track follow-up before relying on it. */
    create_branch: Type.Optional(
      Type.Boolean({
        description:
          "RESERVED — not yet honored by createWorktree. Setting this has no effect today; track follow-up before relying on it.",
      }),
    ),
    allow_dirty: Type.Optional(Type.Boolean()),
    verification: Type.Optional(VerificationConfigSchema),
  },
  { additionalProperties: false },
);

const FollowupSchema = Type.Object(
  {
    allow_dirty: Type.Optional(Type.Boolean()),
    verification: Type.Optional(VerificationConfigSchema),
  },
  { additionalProperties: false },
);

const NotificationsSchema = Type.Object(
  {
    telegram: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const PerformanceSchema = Type.Object(
  {
    /**
     * Coalesce non-terminal TUI widget renders for bursty agent events.
     * Set to 0 to render immediately on every widget-affecting event.
     */
    widget_update_interval_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000 })),
    /** Researcher subprocess policy for fh_team_plan. Config-only in v1. */
    researcher: Type.Optional(ResearcherPolicySchema),
    /** Planner revision strategy. Wired in M4; config-only in v1. */
    plan_revision: Type.Optional(PlanRevisionModeSchema),
  },
  { additionalProperties: false },
);

export const PARALLEL_CONFLICT_POLICIES = ["stop"] as const;
export type ParallelConflictPolicy = (typeof PARALLEL_CONFLICT_POLICIES)[number];
const ParallelConflictPolicySchema = Type.Union(PARALLEL_CONFLICT_POLICIES.map((policy) => Type.Literal(policy)));

const ParallelSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    max_milestones: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    max_stories_per_milestone: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    on_conflict: Type.Optional(ParallelConflictPolicySchema),
    /**
     * When true, parallel runs SKIP the post-merge `tryDeleteBranch` call
     * and leave lane branches in place. Default false (auto-delete on
     * successful merge + worktree removal). Useful for debugging
     * parallel runs where you want to inspect each lane's commit graph.
     */
    keep_lane_branches: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SteeringSchema = Type.Object(
  {
    /** Master switch for fh-team steering control-plane features. */
    enabled: Type.Optional(Type.Boolean()),
    /** Maximum user-authored steering instruction length accepted by durable ingress. */
    max_instruction_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    /** Polling interval used while child agents are active and steering wake events may arrive. */
    child_active_tick_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 60_000 })),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    agents: Type.Optional(
      Type.Object(
        {
          planner: Type.Optional(AgentSchema),
          reviewer: Type.Optional(AgentSchema),
          developer: Type.Optional(AgentSchema),
          researcher: Type.Optional(AgentSchema),
        },
        { additionalProperties: false },
      ),
    ),
    review: Type.Optional(
      Type.Object(
        {
          /**
           * Compatibility fallback used by both plan and implementation
           * review loops when the phase-specific cap is not set.
           */
          max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          /** Cap for planner ↔ reviewer loops. Falls back to max_rounds. */
          plan_max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          /** Cap for developer ↔ reviewer loops. Falls back to max_rounds. */
          implementation_max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
    ),
    workflow: Type.Optional(WorkflowSchema),
    plan: Type.Optional(PlanSchema),
    implement: Type.Optional(ImplementSchema),
    auto: Type.Optional(ImplementSchema),
    task: Type.Optional(TaskSchema),
    followup: Type.Optional(FollowupSchema),
    notifications: Type.Optional(NotificationsSchema),
    performance: Type.Optional(PerformanceSchema),
    parallel: Type.Optional(ParallelSchema),
    steering: Type.Optional(SteeringSchema),
    paths: Type.Optional(PathsConfigSchema),
    tdd: Type.Optional(TddConfigSchema),
  },
  { additionalProperties: false },
);

export type FhTeamConfig = Static<typeof ConfigSchema>;

/**
 * Resolved defaults — every knob the orchestrator might consult resolves to a
 * concrete value here, so the resolution chain (prompt → project → global →
 * Q&A → default) always has a hard fallback. Typed loosely on purpose:
 * Static<T> with optional fields collapses concrete literals to `undefined`,
 * which we work around with a hand-typed shape that matches the schema.
 */
export interface ResolvedDefaults {
  agents: {
    planner: { model: string; thinking: ThinkingLevel; heartbeatMs: number };
    reviewer: { model: string; thinking: ThinkingLevel; heartbeatMs: number };
    developer: { model: string; thinking: ThinkingLevel; heartbeatMs: number };
    researcher: { model: string; thinking: ThinkingLevel; heartbeatMs: number };
  };
  review: { max_rounds: number; plan_max_rounds: number; implementation_max_rounds: number };
  workflow: { profile: WorkflowProfile };
  plan: { verification: VerificationConfigInput };
  implement: {
    mode: ImplementMode;
    use_worktree: boolean;
    create_branch: boolean;
    branch_prefix: string;
    pause_between_milestones: boolean;
    empty_diff_retries: number;
    empty_diff_retry_model?: string;
    verification: VerificationConfigInput;
  };
  auto: {
    mode: ImplementMode;
    use_worktree: boolean;
    create_branch: boolean;
    branch_prefix: string;
    pause_between_milestones: boolean;
    empty_diff_retries: number;
    empty_diff_retry_model?: string;
    verification: VerificationConfigInput;
  };
  task: { use_worktree: boolean; create_branch: boolean; allow_dirty: boolean; verification: VerificationConfigInput };
  followup: { allow_dirty: boolean; verification: VerificationConfigInput };
  notifications: { telegram: { enabled: boolean } };
  performance: { widget_update_interval_ms: number; researcher: ResearcherPolicy; plan_revision: PlanRevisionMode };
  parallel: {
    enabled: boolean;
    max_milestones: number;
    max_stories_per_milestone: number;
    on_conflict: ParallelConflictPolicy;
    keep_lane_branches: boolean;
  };
  steering: { enabled: boolean; max_instruction_chars: number; child_active_tick_ms: number };
  paths: PathsConfig;
  tdd: TddConfig;
}

export const DEFAULT_CONFIG: ResolvedDefaults = {
  agents: {
    planner: { model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 300_000 },
    // Reviewer/developer keep a 10-minute heartbeat because large review
    // and implementation turns can sit silently while the model reasons.
    reviewer: { model: "claude-sonnet-4-6", thinking: "high", heartbeatMs: 600_000 },
    developer: { model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 600_000 },
    researcher: { model: "claude-haiku-4-5", thinking: "low", heartbeatMs: 300_000 },
  },
  review: { max_rounds: 10, plan_max_rounds: 10, implementation_max_rounds: 10 },
  workflow: { profile: "default" },
  plan: { verification: { timing: "off", mode: "commands", stages: ["typecheck", "test"], cache: { mode: "run" }, maxAttempts: 2 } },
  implement: {
    mode: "single-milestone",
    use_worktree: true,
    create_branch: true,
    branch_prefix: "implement/",
    pause_between_milestones: true,
    empty_diff_retries: 2,
    verification: { timing: "after", mode: "commands", stages: ["typecheck", "test"], cache: { mode: "run" }, maxAttempts: 2 },
  },
  auto: {
    mode: "all-milestones",
    use_worktree: true,
    create_branch: true,
    branch_prefix: "auto/",
    pause_between_milestones: false,
    empty_diff_retries: 2,
    verification: { timing: "after", mode: "commands", stages: ["typecheck", "test"], cache: { mode: "run" }, maxAttempts: 2 },
  },
  task: {
    use_worktree: false,
    create_branch: false,
    allow_dirty: false,
    verification: { timing: "after", mode: "commands", stages: ["typecheck", "test"], cache: { mode: "run" }, maxAttempts: 2 },
  },
  followup: {
    allow_dirty: false,
    verification: { timing: "after", mode: "commands", stages: ["typecheck", "test"], cache: { mode: "run" }, maxAttempts: 2 },
  },
  notifications: { telegram: { enabled: false } },
  performance: { widget_update_interval_ms: 150, researcher: "auto", plan_revision: "patch" },
  parallel: { enabled: true, max_milestones: 3, max_stories_per_milestone: 2, on_conflict: "stop", keep_lane_branches: false },
  steering: { enabled: true, max_instruction_chars: 4000, child_active_tick_ms: 5000 },
  paths: { git_mode: "auto" },
  tdd: { mode: "auto" },
};
