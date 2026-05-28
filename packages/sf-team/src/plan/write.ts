import path from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWriteFile, upsertEntry } from "@pi-stef/agent-workflows";

import { EXECUTION_STRATEGY_FILE, FIVE_FILE_NAMES, PLAN_FOLDER_ROOT, planFolderPathFromRoot, TASK_FILE_NAME } from "./paths";

export type PlanKind = "five-file" | "task";

export type FiveFileBody = Partial<Record<(typeof FIVE_FILE_NAMES)[number], string>> & { __required?: never };
export type TaskBody = { "task-plan.md": string };

export type WritePlanFolderInput =
  | {
      kind: "five-file";
      slug: string;
      files: Record<(typeof FIVE_FILE_NAMES)[number], string>;
      executionStrategyJson?: string;
    }
  | { kind: "task"; slug: string; files: TaskBody };

/**
 * Write the plan folder atomically. Each file is staged via `<name>.tmp` and
 * renamed in place so a partial write doesn't corrupt the folder for resume
 * (M9 detectResumeState).
 *
 * - five-file: writes all 5 canonical files into ai_plan/<slug>/
 * - task: writes a single task-plan.md (also used by sf_team_followup,
 *   which gets its own plan folder under ai_plan/<date>-followup-<slug>/
 *   instead of an overlay file in the parent's folder)
 */
export async function writePlanFolder(repoRoot: string, input: WritePlanFolderInput, planRoot?: string): Promise<string> {
  const resolvedPlanRoot = planRoot ?? path.join(repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  const folder = planFolderPathFromRoot(resolvedPlanRoot, input.slug);
  await mkdir(folder, { recursive: true });

  if (input.kind === "five-file") {
    for (const name of FIVE_FILE_NAMES) {
      const body = input.files[name];
      await atomicWriteFile(path.join(folder, name), body);
    }
    if (input.executionStrategyJson !== undefined) {
      await atomicWriteFile(path.join(folder, EXECUTION_STRATEGY_FILE), input.executionStrategyJson);
    }
    upsertEntry(input.slug, { planRoot: resolvedPlanRoot, tool: "sf_team_plan" });
    return folder;
  }
  // task / followup: single-file layout
  await atomicWriteFile(path.join(folder, TASK_FILE_NAME), input.files["task-plan.md"]);
  return folder;
}
