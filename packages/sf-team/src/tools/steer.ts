import { Type } from "typebox";
import path from "node:path";

import { createActiveWorkflowRegistry, type ActiveWorkflowCandidate } from "../steering/active-workflows";
import { createSteeringStore, type SteeringStoreConfig } from "../steering/store";
import type { SteeringInstruction } from "../steering/types";

export interface SfTeamSteerParams {
  instruction: string;
  workflowId?: string;
  planSlug?: string;
  priority?: "normal" | "urgent";
  targetHints?: SteeringInstruction["targetHints"];
  /** External plan root directory. When provided, the active-workflow registry is looked up under planRoot/.sf-team/active-workflows.json instead of repoRoot. */
  aiPlanPath?: string;
}

export interface SfTeamSteerContext {
  repoRoot: string;
  config?: SteeringStoreConfig;
  /** External plan root; when provided, the active-workflow registry lookup uses planRoot instead of repoRoot. */
  aiPlanPath?: string;
}

export type SfTeamSteerResult =
  | {
    ok: true;
    workflowId: string;
    planSlug?: string;
    instructionId: string;
    status: SteeringInstruction["status"];
    message: string;
  }
  | {
    ok: false;
    reason: "no-active-workflow" | "ambiguous-target" | "invalid-instruction";
    message: string;
    candidates?: ActiveWorkflowCandidate[];
  };

export const SfTeamSteerSchema = Type.Object(
  {
    instruction: Type.String({
      minLength: 1,
      description: "Instruction to send to an active sf-team orchestrator.",
    }),
    workflowId: Type.Optional(Type.String({ minLength: 1, description: "Target active workflow id." })),
    planSlug: Type.Optional(Type.String({ minLength: 1, description: "Target active plan slug." })),
    priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("urgent")])),
    aiPlanPath: Type.Optional(Type.String({ description: "External plan root directory. When provided, the active-workflow registry is looked up under this path instead of repoRoot." })),
    targetHints: Type.Optional(
      Type.Object(
        {
          agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          milestones: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          stories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          files: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export function createSfTeamSteer(): (params: SfTeamSteerParams, ctx: SfTeamSteerContext) => Promise<SfTeamSteerResult> {
  return async (params, ctx) => {
    // When aiPlanPath is provided (via params or context), use it as the registry root.
    const registryRoot = params.aiPlanPath ?? ctx.aiPlanPath ?? ctx.repoRoot;
    const registry = createActiveWorkflowRegistry(registryRoot);
    const resolution = await registry.resolve({ workflowId: params.workflowId, planSlug: params.planSlug });
    if (resolution.status === "none") {
      return {
        ok: false,
        reason: "no-active-workflow",
        message: targetDescription(params) === "active workflow"
          ? "No active sf-team workflow is registered."
          : `No active sf-team workflow matches ${targetDescription(params)}.`,
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        ok: false,
        reason: "ambiguous-target",
        candidates: resolution.candidates,
        message: `Multiple active sf-team workflows match. Specify workflowId: ${resolution.candidates.map((c) => c.workflowId).join(", ")}.`,
      };
    }

    const record = resolution.record;
    const recordRepoRoot = record.repoRoot || ctx.repoRoot;
    // Derive expectedRoot from steeringRoot (steeringRoot = planFolder/.fh-workflow/steering)
    // so external aiPlanPath workflows are handled without needing the ai_plan subdir assumption.
    const expectedRoot = record.planSlug
      ? path.dirname(path.dirname(record.steeringRoot))
      : recordRepoRoot;
    const store = createSteeringStore({
      rootDir: record.steeringRoot,
      expectedRoot,
      config: ctx.config,
    });
    try {
      const instruction = await store.appendInstruction({
        workflowId: record.workflowId,
        planSlug: record.planSlug,
        source: "tool",
        text: params.instruction,
        priority: params.priority ?? "normal",
        targetHints: params.targetHints,
      });
      return {
        ok: true,
        workflowId: record.workflowId,
        planSlug: record.planSlug,
        instructionId: instruction.id,
        status: instruction.status,
        message: `Queued steering instruction ${instruction.id} for ${record.workflowId}.`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: "invalid-instruction",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

function targetDescription(params: Pick<SfTeamSteerParams, "workflowId" | "planSlug">): string {
  if (params.workflowId) return `workflowId=${params.workflowId}`;
  if (params.planSlug) return `planSlug=${params.planSlug}`;
  return "active workflow";
}
