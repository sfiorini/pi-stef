import { Type, type Static } from "@sinclair/typebox";

export const ConfigSchema = Type.Object(
  {
    reviewer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    explorer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    audit: Type.Object({
      threshold: Type.Number({ default: 0.94 }),
      max_rounds: Type.Integer({ default: 5 }),
    }),
    tmux: Type.Object({
      enabled: Type.Boolean({ default: true }),
      theme: Type.Union([Type.Literal("codex"), Type.Literal("plain")], { default: "codex" }),
    }),
    worktree: Type.Object({
      branch_prefix: Type.String({ default: "flow/" }),
    }),
  },
  { additionalProperties: false }
);

export type FlowConfig = Static<typeof ConfigSchema>;

export const DEFAULT_CONFIG: FlowConfig = {
  reviewer: {},
  explorer: {},
  audit: { threshold: 0.94, max_rounds: 5 },
  tmux: { enabled: true, theme: "codex" },
  worktree: { branch_prefix: "flow/" },
};

export interface ResolvedFlowConfig extends FlowConfig {
  /** Reviewer model resolved via the 4-step chain, or null if unset. */
  reviewerModel: string | null;
  explorerModel: string | null;
}
