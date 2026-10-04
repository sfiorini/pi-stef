import { Type, type Static } from "@sinclair/typebox";

/**
 * Flow config schema. Models are NOT configured here: each agent's model lives
 * in its `.md` frontmatter (the single source of truth; pi-subagents applies
 * it natively, project `.pi/agents` overriding global). This file only carries
 * runtime SETTINGS.
 *
 * `audit` and `freshReviewResetThreshold` are intentionally retained even
 * though no compiled code reads them — they are consumed via the tier-1 skill
 * prose at run time (audit thresholds, fresh-review reset policy), and keeping
 * their schema slots means user configs carrying them don't warn as unknown.
 * Do NOT remove them as "dead config".
 */
export const ConfigSchema = Type.Object(
  {
    audit: Type.Optional(
      Type.Object(
        {
          threshold: Type.Optional(Type.Number({ default: 0.94 })),
          max_rounds: Type.Optional(Type.Integer({ default: 5 })),
        },
        { additionalProperties: false }
      )
    ),
    worktree: Type.Optional(
      Type.Object(
        {
          branch_prefix: Type.Optional(Type.String({ default: "flow/" })),
        },
        { additionalProperties: false }
      )
    ),
    /** D18: reset to a fresh comprehensive review when the changed-lines ratio
     *  meets or exceeds this threshold (default 0.5). Deterministic — never MAY. */
    freshReviewResetThreshold: Type.Optional(Type.Number({ default: 0.5 })),
  },
  { additionalProperties: false }
);

/** Raw validated config (as read from a file). */
export type FlowConfig = Static<typeof ConfigSchema>;

/**
 * Post-load config: the layered merge with DEFAULT_CONFIG guarantees `audit`
 * and `worktree` are present. This is the shape callers (register.ts) rely on.
 */
export interface LoadedFlowConfig {
  audit: { threshold: number; max_rounds: number };
  worktree: { branch_prefix: string };
  freshReviewResetThreshold: number;
}

export const DEFAULT_CONFIG: LoadedFlowConfig = {
  audit: { threshold: 0.94, max_rounds: 5 },
  worktree: { branch_prefix: "flow/" },
  freshReviewResetThreshold: 0.5,
};

/** A resolved flow settings object: DEFAULT_CONFIG merged with user config. */
export type ResolvedFlowConfig = LoadedFlowConfig;
