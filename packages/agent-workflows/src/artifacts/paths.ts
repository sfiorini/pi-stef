import os from "node:os";
import path from "node:path";
import { PI_DIR, SF_NAMESPACE } from "@pi-stef/paths";

/** Root for plan folders relative to repoRoot. Convention: ai_plan/<slug>/ */
export const PLAN_FOLDER_ROOT = "ai_plan" as const;

// path.join returns string, but consumers expect a template-literal type
export const WORKFLOW_FOLDER_NAME = path.join(PI_DIR, SF_NAMESPACE, "agent-workflows") as `${string}`;
export const WORKFLOW_ARTIFACTS_FOLDER_NAME = "artifacts" as const;
export const WORKFLOW_METADATA_FILE = "workflow.json" as const;
export const CHECKPOINTS_FILE = "checkpoints.json" as const;
export const VERIFICATION_CACHE_FILE = "verification-cache.json" as const;

/**
 * Resolve the absolute parent directory for plan folders (D19).
 *   - aiPlanPath unset      → `<repoRoot>/ai_plan`
 *   - aiPlanPath absolute   → returned normalized (no trailing slash)
 *   - aiPlanPath relative   → resolved against repoRoot
 *   - aiPlanPath starts ~/  → expanded against os.homedir()
 */
export function resolvePlanRoot(repoRoot: string, aiPlanPath?: string): string {
  if (!aiPlanPath) {
    return path.join(repoRoot, PLAN_FOLDER_ROOT);
  }
  let resolved: string;
  if (aiPlanPath.startsWith("~/")) {
    resolved = path.join(os.homedir(), aiPlanPath.slice(2));
  } else if (aiPlanPath === "~") {
    resolved = os.homedir();
  } else {
    resolved = path.resolve(repoRoot, aiPlanPath);
  }
  // Normalize but preserve filesystem root "/"
  const normalized = path.normalize(resolved);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

/**
 * Join planRoot with slug to produce the absolute plan-folder path (D19).
 * Canonical helper for all new sf-team code paths.
 */
export function planFolderPathFromRoot(planRoot: string, slug: string): string {
  return path.join(planRoot, slug);
}

/** Back-compat shim: delegates to planFolderPathFromRoot with the legacy join. */
export function planFolderPath(repoRoot: string, slug: string): string {
  return planFolderPathFromRoot(path.join(repoRoot, PLAN_FOLDER_ROOT), slug);
}

export function workflowFolderPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), WORKFLOW_FOLDER_NAME);
}

export function workflowMetadataPath(repoRoot: string, slug: string): string {
  return path.join(workflowFolderPath(repoRoot, slug), WORKFLOW_METADATA_FILE);
}

export function workflowCheckpointsPath(repoRoot: string, slug: string): string {
  return path.join(workflowFolderPath(repoRoot, slug), CHECKPOINTS_FILE);
}

export function workflowVerificationCachePath(repoRoot: string, slug: string): string {
  return path.join(workflowFolderPath(repoRoot, slug), VERIFICATION_CACHE_FILE);
}

export function workflowArtifactPath(repoRoot: string, slug: string, artifactName: string): string {
  return path.join(workflowFolderPath(repoRoot, slug), WORKFLOW_ARTIFACTS_FOLDER_NAME, artifactName);
}

/** planFolder-based variants: use when aiPlanPath places the plan folder outside the repo. */
export function workflowFolderPathFromPlanFolder(planFolder: string): string {
  return path.join(planFolder, WORKFLOW_FOLDER_NAME);
}
export function workflowCheckpointsPathFromPlanFolder(planFolder: string): string {
  return path.join(workflowFolderPathFromPlanFolder(planFolder), CHECKPOINTS_FILE);
}
export function workflowVerificationCachePathFromPlanFolder(planFolder: string): string {
  return path.join(workflowFolderPathFromPlanFolder(planFolder), VERIFICATION_CACHE_FILE);
}
export function workflowArtifactPathFromPlanFolder(planFolder: string, artifactName: string): string {
  return path.join(workflowFolderPathFromPlanFolder(planFolder), WORKFLOW_ARTIFACTS_FOLDER_NAME, artifactName);
}

/** Standard 5-file layout for plan folders. */
export const FIVE_FILE_NAMES = [
  "original-plan.md",
  "milestone-plan.md",
  "story-tracker.md",
  "continuation-runbook.md",
  "final-transcript.md",
] as const;

/** Optional sixth artifact for parallel-safe implementation planning. */
export const EXECUTION_STRATEGY_FILE = "execution-strategy.json" as const;

/** 1-file layout for single-task workflows. */
export const TASK_FILE_NAME = "task-plan.md" as const;

/** Followup overlay name template: followup-YYYY-MM-DD-<slug>.md */
export function followupOverlayName(date: Date, slug: string): string {
  const day = date.toISOString().slice(0, 10);
  return `followup-${day}-${slug}.md`;
}

export const TRANSCRIPT_FOLDER_NAME = "transcript" as const;
export const TRANSCRIPT_PLANNING_PHASE = "planning" as const;
export const TRANSCRIPT_IMPLEMENTATION_PHASE = "implementation" as const;
export type TranscriptPhase =
  | typeof TRANSCRIPT_PLANNING_PHASE
  | typeof TRANSCRIPT_IMPLEMENTATION_PHASE;

export const DIAGNOSTICS_FOLDER_NAME = "diagnostics" as const;
export const REPORTS_FOLDER_NAME = "reports" as const;
export const RESEARCH_ANSWERS_FILE = "research-answers.json" as const;
/** Legacy filename kept for read-side back-compat on plans created before the dot was dropped. Never written by the new code. */
export const LEGACY_RESEARCH_ANSWERS_FILE = ".research-answers.json" as const;

export function transcriptFolderPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), TRANSCRIPT_FOLDER_NAME);
}

export function transcriptPhaseFolderPath(
  repoRoot: string,
  slug: string,
  phase: TranscriptPhase,
): string {
  return path.join(transcriptFolderPath(repoRoot, slug), phase);
}

export function diagnosticsFolderPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), DIAGNOSTICS_FOLDER_NAME);
}

export function reportsFolderPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), REPORTS_FOLDER_NAME);
}

export function researchAnswersPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), RESEARCH_ANSWERS_FILE);
}

export function legacyResearchAnswersPath(repoRoot: string, slug: string): string {
  return path.join(planFolderPath(repoRoot, slug), LEGACY_RESEARCH_ANSWERS_FILE);
}
