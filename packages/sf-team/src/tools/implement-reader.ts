import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { loadExecutionStrategyForPlanFolder, type ResolvedExecutionStrategy } from "../plan/execution-strategy";
import { PLAN_FOLDER_ROOT, planFolderPathFromRoot } from "../plan/paths";
import { parseStoryTracker, type ParsedMilestone } from "../plan/tracker";

export interface PlanFolderRead {
  slug: string;
  folder: string;
  milestonePlan: string;
  continuationRunbook: string;
  milestones: ParsedMilestone[];
  executionStrategy: ResolvedExecutionStrategy;
}

/**
 * Read the canonical 5-file plan folder for sf_team_implement / sf_team_auto.
 * Returns the milestone-plan + runbook bodies + parsed tracker.
 *
 * Throws when any of the three required files is missing — implement is a
 * contract: the plan folder must already exist (typically created by
 * sf_team_plan or pre-populated by the user).
 */
export async function readImplementPlanFolder(repoRoot: string, slug: string, planRoot?: string): Promise<PlanFolderRead> {
  const resolvedPlanRoot = planRoot ?? path.join(repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const folder = planFolderPathFromRoot(resolvedPlanRoot, slug);
  const folderStat = await stat(folder).catch(() => undefined);
  if (!folderStat || !folderStat.isDirectory()) {
    throw new Error(`sf_team_implement: plan folder not found at ${folder}`);
  }
  const [milestonePlan, continuationRunbook] = await Promise.all([
    readFile(path.join(folder, "milestone-plan.md"), "utf8"),
    readFile(path.join(folder, "continuation-runbook.md"), "utf8"),
  ]);
  const [tracker, executionStrategy] = await Promise.all([
    parseStoryTracker(repoRoot, slug, resolvedPlanRoot),
    loadExecutionStrategyForPlanFolder(repoRoot, slug, resolvedPlanRoot),
  ]);
  return { slug, folder, milestonePlan, continuationRunbook, milestones: tracker.milestones, executionStrategy };
}

/**
 * Filter `milestones` to those that still have at least one runnable story
 * (`pending`, `in-dev`, or steering-created `needs-rework`).
 */
export function pendingMilestones(milestones: ParsedMilestone[]): ParsedMilestone[] {
  return milestones.filter((m) =>
    m.stories.some((s) => s.status === "pending" || s.status === "in-dev" || s.status === "needs-rework"),
  );
}
