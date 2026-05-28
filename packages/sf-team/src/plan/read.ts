import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { EXECUTION_STRATEGY_FILE, FIVE_FILE_NAMES, PLAN_FOLDER_ROOT, planFolderPathFromRoot, TASK_FILE_NAME } from "./paths";

export interface PlanFolderRead {
  slug: string;
  folder: string;
  /** When all five canonical files exist; otherwise individual fields may be undefined. */
  fiveFile?: Record<(typeof FIVE_FILE_NAMES)[number], string>;
  /** Optional sixth artifact for parallel-safe implementation planning. */
  executionStrategyJson?: string;
  taskPlan?: string;
}

/**
 * Read a plan folder. Files that don't exist yet are silently absent.
 *
 * Note: `sf_team_followup` no longer writes overlay files into a parent's
 * plan folder; it creates its own `ai_plan/<date>-followup-<slug>/`
 * sibling instead. We don't surface a `followups` field anymore — old
 * plans that still have overlay files just have extra entries on disk
 * that this reader ignores.
 */
export async function readPlanFolder(repoRoot: string, slug: string, planRoot?: string): Promise<PlanFolderRead> {
  const resolvedPlanRoot = planRoot ?? path.join(repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const folder = planFolderPathFromRoot(resolvedPlanRoot, slug);
  const folderStat = await stat(folder).catch(() => undefined);
  if (!folderStat || !folderStat.isDirectory()) {
    return { slug, folder };
  }

  const entries = await readdir(folder);
  const out: PlanFolderRead = { slug, folder };

  // Five-file layout
  const fiveFileMap: Partial<Record<(typeof FIVE_FILE_NAMES)[number], string>> = {};
  let allFivePresent = true;
  for (const name of FIVE_FILE_NAMES) {
    if (entries.includes(name)) {
      fiveFileMap[name] = await readFile(path.join(folder, name), "utf8");
    } else {
      allFivePresent = false;
    }
  }
  if (allFivePresent) out.fiveFile = fiveFileMap as Record<(typeof FIVE_FILE_NAMES)[number], string>;

  if (entries.includes(EXECUTION_STRATEGY_FILE)) {
    out.executionStrategyJson = await readFile(path.join(folder, EXECUTION_STRATEGY_FILE), "utf8");
  }

  // Task file
  if (entries.includes(TASK_FILE_NAME)) {
    out.taskPlan = await readFile(path.join(folder, TASK_FILE_NAME), "utf8");
  }

  return out;
}
