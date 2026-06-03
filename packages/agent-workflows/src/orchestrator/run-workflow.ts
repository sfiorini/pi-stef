import path from "node:path";

import {
  PLAN_FOLDER_ROOT,
  planFolderPath,
  planFolderPathFromRoot,
  workflowVerificationCachePathFromPlanFolder,
} from "../artifacts/paths";
import { acquireLock, LockHeldError, releaseLock, type LockMetadata } from "../lock/plan-lock";
import { createWorkflowCheckpointRuntime, type WorkflowCheckpointRuntime } from "../state/checkpoint-runtime";
import {
  createWorkflowMetadata,
  readWorkflowMetadata,
  writeWorkflowMetadata,
  type WorkflowMetadata,
  type WorkflowStatus,
  type WorkflowToolName,
} from "../state/workflow-metadata";
import { createVerificationRunCache, type VerificationRunCache } from "../verification/runner";
import type { WorkflowReporter } from "./reporter";

export interface WorkflowResumeDecision {
  resume: boolean;
  state?: unknown;
}

export interface RunWorkflowOptions<TResult = unknown, TBaseline = unknown, TArtifacts = unknown> {
  repoRoot: string;
  slug: string;
  toolName: WorkflowToolName;
  ownerTool?: WorkflowToolName;
  allowOwnerTakeoverFrom?: WorkflowToolName[];
  useWorktree: boolean;
  signal?: AbortSignal;
  resumeMode?: boolean;
  /**
   * Slug of the parent plan when this run derives from one (e.g. a
   * followup against an existing task plan). Persisted into the workflow
   * metadata so resume paths can rehydrate the parent context. Optional;
   * stand-alone runs leave it undefined.
   */
  parentSlug?: string;
  /**
   * Resolved absolute plan-folder root (e.g. `<repoRoot>/ai_plan` or a
   * custom external path). When provided, the workflow lock is placed
   * under planRoot instead of repoRoot, and planRootPath is persisted into
   * workflow.json so resume paths can locate the plan folder.
   */
  planRoot?: string;
  gitMode?: "on" | "off";
  tddMode?: "on" | "off" | "auto";
  promptForResume: (repoRoot: string, slug: string) => Promise<WorkflowResumeDecision>;
  createReporter: (ctx: { lock: LockMetadata; resume: WorkflowResumeDecision }) => WorkflowReporter;
  onLockHeld?: (error: LockHeldError) => void | Promise<void>;
  resolveBaseline?: (ctx: RunWorkflowRuntimeContext<TBaseline>) => Promise<TBaseline | undefined>;
  onSuccess?: (ctx: RunWorkflowRuntimeContext<TBaseline>, result: TResult) => Promise<TArtifacts | undefined>;
  onError?: (ctx: RunWorkflowRuntimeContext<TBaseline>, error: unknown) => Promise<void>;
  beforeReporterDispose?: (ctx: RunWorkflowRuntimeContext<TBaseline>, error: unknown | undefined) => void | Promise<void>;
  afterReporterDispose?: (ctx: RunWorkflowRuntimeContext<TBaseline>, error: unknown | undefined) => void | Promise<void>;
  afterLockRelease?: (ctx: RunWorkflowRuntimeContext<TBaseline>, error: unknown | undefined) => void | Promise<void>;
}

export interface RunWorkflowRuntimeContext<TBaseline = unknown> {
  repoRoot: string;
  slug: string;
  toolName: WorkflowToolName;
  ownerTool: WorkflowToolName;
  useWorktree: boolean;
  signal?: AbortSignal;
  resume: WorkflowResumeDecision;
  lock: LockMetadata;
  reporter: WorkflowReporter;
  checkpoints: WorkflowCheckpointRuntime;
  verificationCache: VerificationRunCache;
  verificationCachePath: string;
  baseline?: TBaseline;
}

export type RunWorkflowResult<TResult, TArtifacts = unknown> =
  | { result: TResult; declinedResume?: false; artifacts?: TArtifacts }
  | { result?: undefined; declinedResume: true };

export type RunWorkflowBody<TResult, TBaseline = unknown> = (
  ctx: RunWorkflowRuntimeContext<TBaseline>,
) => Promise<TResult>;

export async function runWorkflow<TResult, TBaseline = unknown, TArtifacts = unknown>(
  opts: RunWorkflowOptions<TResult, TBaseline, TArtifacts>,
  body: RunWorkflowBody<TResult, TBaseline>,
): Promise<RunWorkflowResult<TResult, TArtifacts>> {
  const resume = await opts.promptForResume(opts.repoRoot, opts.slug);
  if (!resume.resume) {
    return { declinedResume: true };
  }

  let lock: LockMetadata | undefined;
  let runtime: RunWorkflowRuntimeContext<TBaseline> | undefined;
  let bodyError: unknown;
  let metadataStarted = false;
  try {
    try {
      const lockTarget = opts.planRoot
        ? { planRoot: opts.planRoot, repoRoot: opts.repoRoot }
        : opts.repoRoot; // migration-allowed: legacy
      lock = await acquireLock(lockTarget, opts.slug, opts.toolName);
    } catch (error) {
      if (error instanceof LockHeldError) await opts.onLockHeld?.(error);
      throw error;
    }

    const ownerTool = opts.ownerTool ?? opts.toolName;
    await startWorkflowMetadata({
      repoRoot: opts.repoRoot,
      slug: opts.slug,
      ownerTool,
      currentTool: opts.toolName,
      allowOwnerTakeoverFrom: opts.allowOwnerTakeoverFrom,
      parentSlug: opts.parentSlug,
      planRoot: opts.planRoot,
      gitMode: opts.gitMode,
      tddMode: opts.tddMode,
    });
    metadataStarted = true;

    const reporter = opts.createReporter({ lock, resume });
    const planFolder = opts.planRoot
      ? planFolderPathFromRoot(opts.planRoot, opts.slug)
      : planFolderPath(opts.repoRoot, opts.slug); // migration-allowed: legacy
    runtime = {
      repoRoot: opts.repoRoot,
      slug: opts.slug,
      toolName: opts.toolName,
      ownerTool,
      useWorktree: opts.useWorktree,
      signal: opts.signal,
      resume,
      lock,
      reporter,
      checkpoints: createWorkflowCheckpointRuntime({
        repoRoot: opts.repoRoot,
        slug: opts.slug,
        resumeMode: opts.resumeMode,
        planFolder,
      }),
      verificationCache: createVerificationRunCache(),
      verificationCachePath: workflowVerificationCachePathFromPlanFolder(planFolder),
    };
    runtime.baseline = await opts.resolveBaseline?.(runtime);

    const result = await body(runtime);
    const artifacts = await opts.onSuccess?.(runtime, result);
    await finishWorkflowMetadata({
      repoRoot: opts.repoRoot,
      slug: opts.slug,
      currentTool: opts.toolName,
      status: "completed",
      planRoot: opts.planRoot,
    });
    return artifacts === undefined ? { result } : { result, artifacts };
  } catch (error) {
    bodyError = error;
    if (metadataStarted) {
      await finishWorkflowMetadata({
        repoRoot: opts.repoRoot,
        slug: opts.slug,
        currentTool: opts.toolName,
        status: "failed",
        planRoot: opts.planRoot,
      }).catch(() => undefined);
    }
    if (runtime) await opts.onError?.(runtime, error);
    throw error;
  } finally {
    if (runtime) {
      await opts.beforeReporterDispose?.(runtime, bodyError);
      try {
        runtime.reporter.dispose();
      } catch {
        // Reporter disposal must never mask the original body error.
      }
      await opts.afterReporterDispose?.(runtime, bodyError);
    }
    if (lock) {
      const lockTarget = opts.planRoot
        ? { planRoot: opts.planRoot, repoRoot: opts.repoRoot }
        : opts.repoRoot; // migration-allowed: legacy
      await releaseLock(lockTarget, opts.slug).catch(() => undefined);
    }
    if (runtime) {
      await opts.afterLockRelease?.(runtime, bodyError);
    }
  }
}

async function startWorkflowMetadata(input: {
  repoRoot: string;
  slug: string;
  ownerTool: WorkflowToolName;
  currentTool: WorkflowToolName;
  allowOwnerTakeoverFrom?: WorkflowToolName[];
  parentSlug?: string;
  planRoot?: string;
  gitMode?: "on" | "off";
  tddMode?: "on" | "off" | "auto";
}): Promise<WorkflowMetadata> {
  const resolvedPlanRoot = input.planRoot ?? path.join(input.repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const current = await readWorkflowMetadata(input.repoRoot, input.slug, input.planRoot);
  if (!current) {
    const metadata = createWorkflowMetadata({
      slug: input.slug,
      folderPath: planFolderPathFromRoot(resolvedPlanRoot, input.slug),
      ownerTool: input.ownerTool,
      currentTool: input.currentTool,
      phase: "running",
      parentSlug: input.parentSlug,
      planRootPath: resolvedPlanRoot,
      gitMode: input.gitMode,
      tddMode: input.tddMode,
    });
    await writeWorkflowMetadata(input.repoRoot, metadata, input.planRoot);
    return metadata;
  }

  if (current.ownerTool !== input.ownerTool && !input.allowOwnerTakeoverFrom?.includes(current.ownerTool)) {
    throw new Error(
      `workflow metadata for ${input.slug} is owned by ${current.ownerTool}; ${input.ownerTool} cannot run it`,
    );
  }

  const next: WorkflowMetadata = {
    ...current,
    ownerTool: input.ownerTool,
    currentTool: input.currentTool,
    updatedAt: new Date().toISOString(),
    status: "running",
    phase: current.phase || "running",
    // Preserve parentSlug across resumes; only set it on the first start.
    parentSlug: current.parentSlug ?? input.parentSlug,
    // planRootPath: use current if already set; otherwise resolvedPlanRoot.
    planRootPath: current.planRootPath ?? resolvedPlanRoot,
    gitMode: current.gitMode ?? input.gitMode,
    tddMode: current.tddMode ?? input.tddMode,
  };
  await writeWorkflowMetadata(input.repoRoot, next, input.planRoot);
  return next;
}

async function finishWorkflowMetadata(input: {
  repoRoot: string;
  slug: string;
  currentTool: WorkflowToolName;
  status: WorkflowStatus;
  planRoot?: string;
}): Promise<void> {
  const current = await readWorkflowMetadata(input.repoRoot, input.slug, input.planRoot);
  if (!current) return;
  await writeWorkflowMetadata(input.repoRoot, {
    ...current,
    currentTool: input.currentTool,
    updatedAt: new Date().toISOString(),
    status: input.status,
  }, input.planRoot);
}
