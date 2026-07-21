import { Type, type Static } from "@sinclair/typebox";

/**
 * Flow config schema. `reviewer`/`explorer`/`audit`/`worktree` are all
 * Optional so a minimal user config (e.g. `{"reviewer":{"model":"..."}}`)
 * validates. `loadConfig` deep-merges with DEFAULT_CONFIG, guaranteeing the
 * full shape at runtime (see `LoadedFlowConfig`).
 */
export const ConfigSchema = Type.Object(
  {
    reviewer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    explorer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    audit: Type.Optional(
      Type.Object(
        {
          threshold: Type.Number({ default: 0.94 }),
          max_rounds: Type.Integer({ default: 5 }),
        },
        { additionalProperties: false }
      )
    ),
    worktree: Type.Optional(
      Type.Object(
        {
          branch_prefix: Type.String({ default: "flow/" }),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

/** Raw validated config (as read from a file); top-level groups may be absent. */
export type FlowConfig = Static<typeof ConfigSchema>;

/**
 * Post-load config: the layered merge with DEFAULT_CONFIG guarantees every
 * group is present. This is the shape callers (register.ts) rely on.
 */
export interface LoadedFlowConfig {
  reviewer: { model?: string };
  explorer: { model?: string };
  audit: { threshold: number; max_rounds: number };
  worktree: { branch_prefix: string };
}

export const DEFAULT_CONFIG: LoadedFlowConfig = {
  reviewer: {},
  explorer: {},
  audit: { threshold: 0.94, max_rounds: 5 },
  worktree: { branch_prefix: "flow/" },
};

export interface ResolvedFlowConfig extends LoadedFlowConfig {
  /** Reviewer model resolved via the 4-step chain, or null if unset. */
  reviewerModel: string | null;
  explorerModel: string | null;
}
