import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type WorkflowToolName,
  type WorkflowMetadata,
  parseWorkflowMetadata,
  resolvePlanTarget,
  WORKFLOW_FOLDER_NAME,
  WORKFLOW_METADATA_FILE,
} from "@pi-stef/agent-workflows";
import { PLAN_FOLDER_ROOT } from "../plan/paths";
import { WorkflowStateError } from "../errors";
import { createSfTeamPlan } from "./plan";
import { createSfTeamImplement } from "./implement";
import { createSfTeamTask } from "./task";
import { createSfTeamAuto } from "./auto";
import { createSfTeamFollowup } from "./followup";

export interface UnifiedResumeInput {
  resume?: string;
  maxRounds?: number;
  allowDirty?: boolean;
  verification?: Record<string, unknown>;
  aiPlanPath?: string;
  gitMode?: "auto" | "on" | "off";
  tddMode?: "auto" | "on" | "off";
}

interface LatestWorkflow {
  slug: string;
  folderPath: string;
}

type HandlerResult = unknown;

interface ResumeHandlerContext {
  repoRoot: string;
  signal?: AbortSignal;
  ui?: unknown;
  configDefaults?: unknown;
  planRoot?: string;
  gitMode?: "on" | "off";
  tddMode?: "on" | "off" | "auto";
  rawGitMode?: "auto" | "on" | "off";
  rawTddMode?: "auto" | "on" | "off";
}

/**
 * Scan planRoot subdirectories for the most recently updated workflow
 * (by workflow.json updatedAt field). Returns undefined when no workflows exist.
 */
export async function findLatestWorkflow(planRoot: string): Promise<LatestWorkflow | undefined> {
  let names: string[];
  try {
    names = await readdir(planRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let latest: LatestWorkflow | undefined;
  let latestDate = "";

  for (const name of names) {
    const folderPath = path.join(planRoot, name);
    const folderStat = await stat(folderPath).catch(() => null);
    if (!folderStat?.isDirectory()) continue;

    const metadata = await readWorkflowMetadataSafe(folderPath);
    if (metadata && metadata.updatedAt > latestDate) {
      latestDate = metadata.updatedAt;
      latest = { slug: name, folderPath };
    }
  }

  return latest;
}

/**
 * Read and validate workflow.json from a plan folder. Returns undefined if
 * missing or invalid. Uses parseWorkflowMetadata from agent-workflows for
 * full validation (schemaVersion, required fields, etc.).
 */
export async function readWorkflowMetadataSafe(folderPath: string): Promise<WorkflowMetadata | undefined> {
  const metadataPath = path.join(folderPath, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE);
  try {
    const raw = await readFile(metadataPath, "utf8");
    return parseWorkflowMetadata(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Read workflow.json and return the ownerTool that should handle this resume.
 */
export async function resolveOwnerTool(
  folderPath: string,
  slug: string,
): Promise<WorkflowToolName> {
  const metadata = await readWorkflowMetadataSafe(folderPath);
  if (!metadata) {
    throw new WorkflowStateError({
      toolName: "sf_team_resume",
      description: `workflow metadata not found for ${slug}; cannot determine which tool owns this workflow`,
      resumeHint: `verify the plan folder at ${folderPath} has a valid .pi/sf/agent-workflows/workflow.json`,
      details: { slug, folderPath },
    });
  }
  return metadata.ownerTool as WorkflowToolName;
}

/**
 * Create the unified sf_team_resume handler. Reads workflow.json to
 * determine ownerTool, then delegates to the correct tool handler.
 */
export function createSfTeamResume() {
  return async function sfTeamResume(
    input: UnifiedResumeInput,
    ctx: ResumeHandlerContext,
  ): Promise<{ ownerTool: string; result: HandlerResult }> {
    const planRoot = ctx.planRoot ?? path.join(ctx.repoRoot, PLAN_FOLDER_ROOT);

    // Resolve target: explicit resume or latest workflow
    let slug: string;
    let folderPath: string;

    if (input.resume) {
      const target = await resolvePlanTarget({
        repoRoot: ctx.repoRoot,
        target: input.resume,
        candidatePlanRoots: [planRoot],
      });
      slug = target.slug;
      folderPath = target.folderPath;
    } else {
      const latest = await findLatestWorkflow(planRoot);
      if (!latest) {
        throw new WorkflowStateError({
          toolName: "sf_team_resume",
          description: "no workflows found to resume",
          resumeHint: "start a new workflow with sf_team_plan, sf_team_task, or sf_team_auto",
          details: { planRoot },
        });
      }
      slug = latest.slug;
      folderPath = latest.folderPath;
    }

    // Determine owner from metadata
    const ownerTool = await resolveOwnerTool(folderPath, slug);

    // Dispatch to the correct handler
    const resumeInput = { resume: slug, ...input };
    const handlerCtx = { ...ctx, toolName: "sf_team_resume" };

    let result: HandlerResult;
    switch (ownerTool) {
      case "sf_team_plan":
        result = await createSfTeamPlan()(resumeInput as any, handlerCtx as any);
        break;
      case "sf_team_implement":
        result = await createSfTeamImplement()(resumeInput as any, handlerCtx as any);
        break;
      case "sf_team_task":
        result = await createSfTeamTask()(resumeInput as any, handlerCtx as any);
        break;
      case "sf_team_auto":
        result = await createSfTeamAuto()(resumeInput as any, handlerCtx as any);
        break;
      case "sf_team_followup":
        result = await createSfTeamFollowup()(resumeInput as any, handlerCtx as any);
        break;
      default:
        throw new WorkflowStateError({
          toolName: "sf_team_resume",
          description: `unknown ownerTool "${ownerTool}" for workflow ${slug}`,
          resumeHint: "check the workflow.json file for a valid ownerTool value",
          details: { slug, ownerTool },
        });
    }

    return { ownerTool, result };
  };
}
