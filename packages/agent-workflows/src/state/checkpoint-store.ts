import { readFile } from "node:fs/promises";

import { writeJsonAtomic } from "../artifacts/atomic-write";
import { workflowCheckpointsPath } from "../artifacts/paths";
import type { CheckpointRef, CommitIntent } from "./workflow-metadata";

export interface WorkflowCheckpointStore {
  schemaVersion: 1;
  slug: string;
  updatedAt: string;
  checkpoints: Record<string, CheckpointRef>;
  commitIntents: Record<string, CommitIntent>;
}

export interface RecordCheckpointStartedInput {
  stepId: string;
  artifactPath?: string;
  inputFingerprint?: string;
  now?: Date;
}

export interface RecordCheckpointCompletedInput {
  stepId: string;
  artifactPath?: string;
  outputFingerprint?: string;
  now?: Date;
}

export function emptyCheckpointStore(slug: string, now: Date = new Date()): WorkflowCheckpointStore {
  return {
    schemaVersion: 1,
    slug,
    updatedAt: now.toISOString(),
    checkpoints: {},
    commitIntents: {},
  };
}

export async function writeCheckpointStore(repoRoot: string, store: WorkflowCheckpointStore, pathOverride?: string): Promise<void> {
  await writeJsonAtomic(pathOverride ?? workflowCheckpointsPath(repoRoot, store.slug), store);
}

export async function readCheckpointStore(repoRoot: string, slug: string, pathOverride?: string): Promise<WorkflowCheckpointStore | undefined> {
  try {
    const raw = await readFile(pathOverride ?? workflowCheckpointsPath(repoRoot, slug), "utf8");
    return parseCheckpointStore(JSON.parse(raw));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export function recordCheckpointStarted(
  store: WorkflowCheckpointStore,
  input: RecordCheckpointStartedInput,
): WorkflowCheckpointStore {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...store,
    updatedAt: now,
    checkpoints: {
      ...store.checkpoints,
      [input.stepId]: {
        stepId: input.stepId,
        status: "started",
        artifactPath: input.artifactPath,
        inputFingerprint: input.inputFingerprint,
        startedAt: now,
      },
    },
  };
}

export function recordCheckpointCompleted(
  store: WorkflowCheckpointStore,
  input: RecordCheckpointCompletedInput,
): WorkflowCheckpointStore {
  const now = (input.now ?? new Date()).toISOString();
  const current = store.checkpoints[input.stepId];
  return {
    ...store,
    updatedAt: now,
    checkpoints: {
      ...store.checkpoints,
      [input.stepId]: {
        stepId: input.stepId,
        status: "completed",
        artifactPath: input.artifactPath ?? current?.artifactPath,
        inputFingerprint: current?.inputFingerprint,
        outputFingerprint: input.outputFingerprint,
        startedAt: current?.startedAt ?? now,
        completedAt: now,
      },
    },
  };
}

export function recordCheckpointFailed(
  store: WorkflowCheckpointStore,
  input: RecordCheckpointCompletedInput,
): WorkflowCheckpointStore {
  const now = (input.now ?? new Date()).toISOString();
  const current = store.checkpoints[input.stepId];
  return {
    ...store,
    updatedAt: now,
    checkpoints: {
      ...store.checkpoints,
      [input.stepId]: {
        stepId: input.stepId,
        status: "failed",
        artifactPath: input.artifactPath ?? current?.artifactPath,
        inputFingerprint: current?.inputFingerprint,
        outputFingerprint: input.outputFingerprint,
        startedAt: current?.startedAt ?? now,
        completedAt: now,
      },
    },
  };
}

export function recordCommitIntent(store: WorkflowCheckpointStore, intent: CommitIntent): WorkflowCheckpointStore {
  return {
    ...store,
    commitIntents: {
      ...store.commitIntents,
      [intent.intentId]: intent,
    },
  };
}

export function parseCheckpointStore(value: unknown): WorkflowCheckpointStore {
  if (!isRecord(value)) throw new Error("invalid checkpoint store: expected object");
  if (value.schemaVersion !== 1) throw new Error("invalid checkpoint store: unsupported schemaVersion");
  if (typeof value.slug !== "string") throw new Error("invalid checkpoint store: slug must be a string");
  if (typeof value.updatedAt !== "string") throw new Error("invalid checkpoint store: updatedAt must be a string");
  if (!isRecord(value.checkpoints)) throw new Error("invalid checkpoint store: checkpoints must be an object");
  if (!isRecord(value.commitIntents)) throw new Error("invalid checkpoint store: commitIntents must be an object");
  const parsed = value as unknown as WorkflowCheckpointStore;
  return {
    ...parsed,
    checkpoints: { ...parsed.checkpoints },
    commitIntents: { ...parsed.commitIntents },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
