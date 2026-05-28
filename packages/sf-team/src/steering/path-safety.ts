import { randomBytes } from "node:crypto";
import path from "node:path";

export type SteeringWorkflowKind = "plan" | "implement" | "auto" | "task" | "followup";

const RUN_ID_RE = /^fhw_[a-z]+_\d{14}_[a-f0-9]{8}$/;

export function assertPathInsideRoot(targetPath: string, expectedRoot: string): string {
  // This is lexical containment for planned workflow paths. Callers handling
  // user-created symlinks must resolve realpaths before trusting containment.
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(expectedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  throw new Error(`Steering path ${resolvedTarget} is outside expected root ${resolvedRoot}`);
}

export function resolvePlanSteeringRoot(planFolder: string): string {
  const resolvedPlanFolder = path.resolve(planFolder);
  const steeringRoot = path.join(resolvedPlanFolder, ".fh-workflow", "steering");
  return assertPathInsideRoot(steeringRoot, resolvedPlanFolder);
}

export function resolveRunSteeringRoot(workflowRoot: string, runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid steering run id: ${runId}`);
  }
  const resolvedWorkflowRoot = path.resolve(workflowRoot);
  const steeringRoot = path.join(resolvedWorkflowRoot, ".sf-team", "runs", runId, "steering");
  return assertPathInsideRoot(steeringRoot, resolvedWorkflowRoot);
}

export function createWorkflowRunId(kind: SteeringWorkflowKind, date = new Date()): string {
  const stamp = date.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = randomBytes(4).toString("hex");
  return `fhw_${kind}_${stamp}_${suffix}`;
}

export function assertSafeSnapshotName(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid steering snapshot name: ${name}`);
  }
  return name;
}
