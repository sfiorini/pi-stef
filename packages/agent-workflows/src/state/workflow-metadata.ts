import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "../artifacts/atomic-write";
import {
  planFolderPathFromRoot,
  workflowMetadataPath,
  WORKFLOW_FOLDER_NAME,
  WORKFLOW_METADATA_FILE,
} from "../artifacts/paths";

export type WorkflowToolName =
  | "sf_team_plan"
  | "sf_team_implement"
  | "sf_team_task"
  | "sf_team_auto"
  | "sf_team_followup";

export type WorkflowStatus = "running" | "paused" | "completed" | "failed" | "aborted";

export type CheckpointStatus = "started" | "completed" | "failed";

export interface CheckpointRef {
  stepId: string;
  status: CheckpointStatus;
  artifactPath?: string;
  inputFingerprint?: string;
  outputFingerprint?: string;
  startedAt: string;
  completedAt?: string;
}

export interface CommitIntent {
  intentId: string;
  stepId: string;
  cwd: string;
  message: string;
  expectedSubject: string;
  expectedTree: string;
  expectedParent: string;
  allowEmpty: boolean;
  createdCommit?: string;
  actualMessage?: string;
}

export interface WorkflowMetadata {
  schemaVersion: 1;
  slug: string;
  folderPath: string;
  ownerTool: WorkflowToolName;
  currentTool: WorkflowToolName;
  createdAt: string;
  updatedAt: string;
  status: WorkflowStatus;
  phase: string;
  lastCompletedStepId?: string;
  currentStepId?: string;
  parentSlug?: string;
  followupName?: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
  checkpoints: Record<string, CheckpointRef>;
  commitIntents: Record<string, CommitIntent>;
  /** Resolved absolute parent directory for plan folders. Persisted for resume discovery. */
  planRootPath?: string;
  /** Git policy in effect when the workflow was started. Defaults to 'on' when absent (legacy). */
  gitMode?: "on" | "off";
  /** TDD policy in effect when the workflow was started. Defaults to 'auto' when absent (legacy). */
  tddMode?: "on" | "off" | "auto";
}

export interface CreateWorkflowMetadataInput {
  slug: string;
  folderPath: string;
  ownerTool: WorkflowToolName;
  currentTool: WorkflowToolName;
  phase: string;
  now?: Date;
  parentSlug?: string;
  followupName?: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
  planRootPath?: string;
  gitMode?: "on" | "off";
  tddMode?: "on" | "off" | "auto";
}

export function createWorkflowMetadata(input: CreateWorkflowMetadataInput): WorkflowMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    slug: input.slug,
    folderPath: input.folderPath,
    ownerTool: input.ownerTool,
    currentTool: input.currentTool,
    createdAt: now,
    updatedAt: now,
    status: "running",
    phase: input.phase,
    parentSlug: input.parentSlug,
    followupName: input.followupName,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseRef: input.baseRef,
    checkpoints: {},
    commitIntents: {},
    planRootPath: input.planRootPath,
    gitMode: input.gitMode,
    tddMode: input.tddMode,
  };
}

function resolveMetadataPath(repoRoot: string, slug: string, planRoot?: string): string {
  if (planRoot) {
    return path.join(planFolderPathFromRoot(planRoot, slug), WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE);
  }
  return workflowMetadataPath(repoRoot, slug); // migration-allowed: legacy
}

export async function writeWorkflowMetadata(
  repoRoot: string,
  metadata: WorkflowMetadata,
  planRoot?: string,
): Promise<void> {
  await writeJsonAtomic(resolveMetadataPath(repoRoot, metadata.slug, planRoot), metadata);
}

export async function readWorkflowMetadata(
  repoRoot: string,
  slug: string,
  planRoot?: string,
): Promise<WorkflowMetadata | undefined> {
  try {
    const raw = await readFile(resolveMetadataPath(repoRoot, slug, planRoot), "utf8");
    return parseWorkflowMetadata(JSON.parse(raw));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function updateWorkflowMetadata(
  repoRoot: string,
  slug: string,
  updater: (metadata: WorkflowMetadata) => WorkflowMetadata,
  planRoot?: string,
): Promise<WorkflowMetadata> {
  const current = await readWorkflowMetadata(repoRoot, slug, planRoot);
  if (!current) throw new Error(`workflow metadata not found for ${slug}`);
  const next = updater(current);
  await writeWorkflowMetadata(repoRoot, next, planRoot);
  return next;
}

export function parseWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (!isRecord(value)) throw new Error("invalid workflow metadata: expected object");
  if (typeof value.schemaVersion !== "number") throw new Error("invalid workflow metadata: schemaVersion must be a number");
  if (value.schemaVersion !== 1) throw new Error("invalid workflow metadata: unsupported schemaVersion");
  const requiredStrings = ["slug", "folderPath", "ownerTool", "currentTool", "createdAt", "updatedAt", "status", "phase"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string") throw new Error(`invalid workflow metadata: ${key} must be a string`);
  }
  if (!isRecord(value.checkpoints)) throw new Error("invalid workflow metadata: checkpoints must be an object");
  if (!isRecord(value.commitIntents)) throw new Error("invalid workflow metadata: commitIntents must be an object");
  const parsed = value as unknown as WorkflowMetadata;
  return {
    ...parsed,
    gitMode: parsed.gitMode ?? "on",
    tddMode: parsed.tddMode ?? "auto",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
