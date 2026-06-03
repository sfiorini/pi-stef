import { stat } from "node:fs/promises";
import path from "node:path";

import { planFolderPath, planFolderPathFromRoot, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE } from "../artifacts/paths"; // migration-allowed: legacy
import { lookupEntries } from "./plan-index";
import { ResumeTargetNotFoundError } from "./errors";

export type ResumeTargetKind = "slug" | "absolute-path" | "relative-path";

export interface ResolvePlanTargetInput {
  repoRoot: string;
  target: string;
  cwd?: string;
  /**
   * Ordered list of planRoot directories to check for `<root>/<slug>/.pi/sf/agent-workflows/workflow.json`
   * before falling through to the global plan-index. When omitted, falls back to the legacy
   * `<repoRoot>/ai_plan/<slug>/` behavior for back-compat.
   */
  candidatePlanRoots?: string[];
}

export interface ResolvedPlanTarget {
  slug: string;
  folderPath: string;
  target: string;
  targetKind: ResumeTargetKind;
}

export async function resolvePlanTarget(input: ResolvePlanTargetInput): Promise<ResolvedPlanTarget> {
  const target = input.target.trim();
  if (target.length === 0) {
    throw new Error("resume target must be a non-empty slug or path");
  }

  const targetKind = classifyTarget(target);

  if (targetKind !== "slug") {
    const folderPath = path.resolve(
      targetKind === "absolute-path" ? path.sep : (input.cwd ?? input.repoRoot),
      target,
    );
    let folderStat: Awaited<ReturnType<typeof stat>>;
    try {
      folderStat = await stat(folderPath);
    } catch {
      throw new Error(`resume target not found: ${target} (resolved to ${folderPath})`);
    }
    if (!folderStat.isDirectory()) {
      throw new Error(`resume target is not a plan folder: ${target} (resolved to ${folderPath})`);
    }
    return { slug: path.basename(folderPath), folderPath, target, targetKind };
  }

  // Slug resolution: cascade through candidate planRoots, then global index.
  const slug = target;

  if (input.candidatePlanRoots !== undefined) {
    // New cascade: check each explicit candidate for workflow.json
    for (const planRoot of input.candidatePlanRoots) {
      const folderPath = planFolderPathFromRoot(planRoot, slug);
      const workflowJson = path.join(folderPath, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE);
      if (await fileExists(workflowJson)) {
        return { slug, folderPath, target, targetKind };
      }
    }

    // Fall through to global plan-index
    const liveEntries = lookupEntries(slug);
    if (liveEntries.length === 1) {
      const folderPath = planFolderPathFromRoot(liveEntries[0].planRoot, slug);
      return { slug, folderPath, target, targetKind };
    }
    if (liveEntries.length >= 2) {
      throw new ResumeTargetNotFoundError({
        kind: "ambiguous",
        slug,
        candidates: liveEntries.map((e) => e.planRoot),
        message: `slug \`${slug}\` found at multiple planRoots; pass \`aiPlanPath\` explicitly. Candidates:\n${liveEntries.map((e) => `  - ${e.planRoot}`).join("\n")}`,
      });
    }
    throw new ResumeTargetNotFoundError({
      kind: "not-found",
      slug,
      candidates: input.candidatePlanRoots,
      message: `resume target not found: ${slug} (checked ${input.candidatePlanRoots.length} candidate(s) and global index)`,
    });
  }

  // Legacy back-compat: no candidatePlanRoots → old behavior
  const folderPath = planFolderPath(input.repoRoot, slug); // migration-allowed: legacy
  let folderStat: Awaited<ReturnType<typeof stat>>;
  try {
    folderStat = await stat(folderPath);
  } catch {
    throw new Error(`resume target not found: ${slug} (resolved to ${folderPath})`);
  }
  if (!folderStat.isDirectory()) {
    throw new Error(`resume target is not a plan folder: ${slug} (resolved to ${folderPath})`);
  }
  return { slug, folderPath, target, targetKind };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function classifyTarget(target: string): ResumeTargetKind {
  if (path.isAbsolute(target)) return "absolute-path";
  if (target.startsWith(".") || target.includes("/") || target.includes("\\")) return "relative-path";
  return "slug";
}
