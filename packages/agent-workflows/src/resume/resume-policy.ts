import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { FIVE_FILE_NAMES, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE } from "../artifacts/paths";
import { parseWorkflowMetadata, type WorkflowMetadata, type WorkflowToolName } from "../state/workflow-metadata";
import { readCheckpointEvidenceFromFolder } from "./checkpoint-evidence";
import type { ResolvedPlanTarget } from "./resolve-plan-target";

export type ResumeOwnership =
  | { kind: "metadata"; metadata: WorkflowMetadata }
  | { kind: "legacy-five-file" }
  | { kind: "auto-checkpoint-recovery" };

export interface AssertResumeOwnershipInput {
  repoRoot: string;
  target: ResolvedPlanTarget;
  invokedTool: WorkflowToolName;
}

export async function assertResumeOwnership(input: AssertResumeOwnershipInput): Promise<ResumeOwnership> {
  const metadata = await readWorkflowMetadataFromFolder(input.target.folderPath);
  if (metadata) {
    if (metadata.ownerTool !== input.invokedTool) {
      throw new Error(
        `resume target ${input.target.slug} is owned by ${metadata.ownerTool}; ${input.invokedTool} cannot resume it`,
      );
    }
    return { kind: "metadata", metadata };
  }

  if (input.invokedTool === "sf_team_implement" && await hasLegacyFiveFilePlan(input.target.folderPath)) {
    return { kind: "legacy-five-file" };
  }

  if (input.invokedTool === "sf_team_auto" && await hasLegacyFiveFilePlan(input.target.folderPath)) {
    const evidence = await readCheckpointEvidenceFromFolder(input.target.folderPath);
    if (evidence.hasPlanPhaseCheckpoint && evidence.hasImplementationPhaseCheckpoint) {
      return { kind: "auto-checkpoint-recovery" };
    }
  }

  throw new Error(missingMetadataMessage(input));
}

export async function readWorkflowMetadataFromFolder(folderPath: string): Promise<WorkflowMetadata | undefined> {
  const metadataPath = path.join(folderPath, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE);
  try {
    const raw = await readFile(metadataPath, "utf8");
    return parseWorkflowMetadata(JSON.parse(raw));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function hasLegacyFiveFilePlan(folderPath: string): Promise<boolean> {
  for (const name of FIVE_FILE_NAMES) {
    try {
      await access(path.join(folderPath, name));
    } catch {
      return false;
    }
  }
  return true;
}

function missingMetadataMessage(input: AssertResumeOwnershipInput): string {
  return [
    `workflow metadata not found for ${input.target.slug}; ${input.invokedTool} cannot verify resume ownership.`,
    "Supported metadata-less resume paths are sf_team_implement legacy five-file plans",
    "and sf_team_auto folders with both plan and implementation checkpoints.",
  ].join(" ");
}
