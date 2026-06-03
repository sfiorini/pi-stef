import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "../artifacts/atomic-write";
import {
  workflowArtifactPath,
  workflowArtifactPathFromPlanFolder,
  workflowCheckpointsPath,
  workflowCheckpointsPathFromPlanFolder,
} from "../artifacts/paths";
import {
  emptyCheckpointStore,
  parseCheckpointStore,
  readCheckpointStore,
  recordCheckpointCompleted,
  recordCheckpointFailed,
  recordCheckpointStarted,
  writeCheckpointStore,
  type WorkflowCheckpointStore,
} from "./checkpoint-store";

export interface WorkflowCheckpointRuntimeOptions {
  repoRoot: string;
  slug: string;
  resumeMode?: boolean;
  /** Explicit plan folder path. When set, overrides the legacy repoRoot+slug path computation. */
  planFolder?: string;
}

export interface WorkflowCheckpointRuntime {
  readonly repoRoot: string;
  readonly slug: string;
  readonly resumeMode: boolean;
  recordStarted(stepId: string, input: unknown, artifactPath?: string): Promise<void>;
  runTextStep(stepId: string, input: unknown, producer: () => Promise<string>): Promise<string>;
  runVoidStepSync(stepId: string, input: unknown, producer: () => void): void;
}

export function createWorkflowCheckpointRuntime(
  opts: WorkflowCheckpointRuntimeOptions,
): WorkflowCheckpointRuntime {
  let queue: Promise<unknown> = Promise.resolve();
  const checkpointsPath = opts.planFolder
    ? workflowCheckpointsPathFromPlanFolder(opts.planFolder)
    : undefined;
  const load = async (): Promise<WorkflowCheckpointStore> =>
    await readCheckpointStore(opts.repoRoot, opts.slug, checkpointsPath) ?? emptyCheckpointStore(opts.slug);
  const mutate = async (fn: (store: WorkflowCheckpointStore) => WorkflowCheckpointStore): Promise<void> => {
    const next = queue.then(async () => {
      const store = await load();
      await writeCheckpointStore(opts.repoRoot, fn(store), checkpointsPath);
    });
    queue = next;
    await next;
  };
  const artifactFor = (stepId: string): string =>
    opts.planFolder
      ? workflowArtifactPathFromPlanFolder(opts.planFolder, `${safeArtifactName(stepId)}.txt`)
      : workflowArtifactPath(opts.repoRoot, opts.slug, `${safeArtifactName(stepId)}.txt`);

  const runtime: WorkflowCheckpointRuntime = {
    repoRoot: opts.repoRoot,
    slug: opts.slug,
    resumeMode: opts.resumeMode === true,

    async recordStarted(stepId, input, artifactPath): Promise<void> {
      await mutate((store) => recordCheckpointStarted(store, {
        stepId,
        artifactPath,
        inputFingerprint: workflowFingerprint(input),
      }));
    },

    async runTextStep(stepId, input, producer): Promise<string> {
      const inputFingerprint = workflowFingerprint(input);
      if (runtime.resumeMode) {
        const store = await load();
        const prior = store.checkpoints[stepId];
        if (prior?.status === "completed" && prior.artifactPath && prior.inputFingerprint === inputFingerprint) {
          return readFile(prior.artifactPath, "utf8");
        }
      }

      const artifactPath = artifactFor(stepId);
      await mutate((store) => recordCheckpointStarted(store, {
        stepId,
        artifactPath,
        inputFingerprint,
      }));
      try {
        const output = await producer();
        await atomicWriteFile(artifactPath, output);
        await mutate((store) => recordCheckpointCompleted(store, {
          stepId,
          artifactPath,
          outputFingerprint: workflowFingerprint(output),
        }));
        return output;
      } catch (err) {
        await mutate((store) => recordCheckpointFailed(store, {
          stepId,
          artifactPath,
          outputFingerprint: err instanceof Error ? workflowFingerprint(err.message) : workflowFingerprint(String(err)),
        })).catch(() => {/* best-effort failure recording */});
        throw err;
      }
    },

    runVoidStepSync(stepId, input, producer): void {
      const inputFingerprint = workflowFingerprint(input);
      if (runtime.resumeMode) {
        const store = loadSync(opts.repoRoot, opts.slug, checkpointsPath);
        const prior = store.checkpoints[stepId];
        if (prior?.status === "completed" && prior.inputFingerprint === inputFingerprint) return;
      }

      const artifactPath = artifactFor(stepId);
      mutateSync(opts.repoRoot, opts.slug, (store) => recordCheckpointStarted(store, {
        stepId,
        artifactPath,
        inputFingerprint,
      }), checkpointsPath);
      try {
        producer();
        writeFileAtomicSync(artifactPath, "ok\n");
        mutateSync(opts.repoRoot, opts.slug, (store) => recordCheckpointCompleted(store, {
          stepId,
          artifactPath,
          outputFingerprint: workflowFingerprint("ok"),
        }), checkpointsPath);
      } catch (err) {
        mutateSync(opts.repoRoot, opts.slug, (store) => recordCheckpointFailed(store, {
          stepId,
          artifactPath,
          outputFingerprint: err instanceof Error ? workflowFingerprint(err.message) : workflowFingerprint(String(err)),
        }), checkpointsPath);
        throw err;
      }
    },
  };
  return runtime;
}

export function workflowFingerprint(value: unknown): string {
  const body = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(body).digest("hex");
}

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "checkpoint";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function loadSync(repoRoot: string, slug: string, pathOverride?: string): WorkflowCheckpointStore {
  const filePath = pathOverride ?? workflowCheckpointsPath(repoRoot, slug);
  try {
    return parseCheckpointStore(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return emptyCheckpointStore(slug);
    }
    throw err;
  }
}

function mutateSync(
  repoRoot: string,
  slug: string,
  fn: (store: WorkflowCheckpointStore) => WorkflowCheckpointStore,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? workflowCheckpointsPath(repoRoot, slug);
  const next = fn(loadSync(repoRoot, slug, pathOverride));
  writeFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

function writeFileAtomicSync(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, filePath);
}
