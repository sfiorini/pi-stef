import { Type, type Static } from "@sinclair/typebox";

/**
 * Flow config schema. Ten agent model groups (`reviewer`/`researcher`/
 * `developer`/`planner`/`auditor`/`synth`/`designer` + `elicitor`/`notifier`/`scanner`),
 * plus `audit` and `worktree` are all Optional so a minimal user config
 * (e.g. `{"reviewer":{"model":"..."}}`) validates. `loadConfig` deep-merges
 * with DEFAULT_CONFIG, guaranteeing the full shape at runtime (see `LoadedFlowConfig`).
 */
export const ConfigSchema = Type.Object(
  {
    reviewer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    researcher: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    developer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    planner: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    auditor: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    synth: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    designer: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    elicitor: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    notifier: Type.Optional(
      Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false })
    ),
    scanner: Type.Optional(
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
  researcher: { model?: string };
  developer: { model?: string };
  planner: { model?: string };
  auditor: { model?: string };
  synth: { model?: string };
  designer: { model?: string };
  elicitor: { model?: string };
  notifier: { model?: string };
  scanner: { model?: string };
  audit: { threshold: number; max_rounds: number };
  worktree: { branch_prefix: string };
}

export const DEFAULT_CONFIG: LoadedFlowConfig = {
  reviewer: {},
  researcher: {},
  developer: {},
  planner: {},
  auditor: {},
  synth: {},
  designer: {},
  elicitor: {},
  notifier: {},
  scanner: {},
  audit: { threshold: 0.94, max_rounds: 5 },
  worktree: { branch_prefix: "flow/" },
};

/** The ten resolved agent models (7 tier-1 roles + elicitor + notifier + scanner; deterministic front-end; null ⇒ inherit orchestrator). */
export interface ResolvedModels {
  reviewerModel: string | null;
  researcherModel: string | null;
  developerModel: string | null;
  plannerModel: string | null;
  auditorModel: string | null;
  synthModel: string | null;
  designerModel: string | null;
  elicitorModel: string | null;
  notifierModel: string | null;
  scannerModel: string | null;
}

/** Map an agent name to its resolved config model, or null if no match. */
export function configModelFor(name: string, models: ResolvedModels | null): string | null {
  if (!models) return null;
  switch (name.toLowerCase()) {
    case "reviewer": return models.reviewerModel;
    case "researcher": return models.researcherModel;
    case "developer": return models.developerModel;
    case "planner": return models.plannerModel;
    case "auditor": return models.auditorModel;
    case "synth": return models.synthModel;
    case "designer": return models.designerModel;
    case "elicitor": return models.elicitorModel;
    case "notifier": return models.notifierModel;
    case "scanner": return models.scannerModel;
    default: return null;
  }
}

export interface ResolvedFlowConfig extends LoadedFlowConfig, ResolvedModels {}
