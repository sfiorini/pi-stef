import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { PLAN_FOLDER_ROOT } from "../plan/paths";

export interface ResolvedParentPlan {
  slug: string;
  folder: string;
}

/**
 * Resolve the parent plan slug for a followup. Strategy:
 *   - If `prompt.plan` is set: accept it as a bare slug (e.g.
 *     `2026-05-08-add-foo`), an absolute path
 *     (`/path/to/repo/ai_plan/2026-05-08-add-foo`), or a relative path
 *     (`./ai_plan/2026-05-08-add-foo`). The folder must exist.
 *   - Else: auto-detect the latest entry under ai_plan/ (most recent by name).
 *   - When multiple candidates exist and `selectFromAmbiguous` is provided,
 *     ask the user (typically pi.ui.select) which to use.
 *
 * Throws when no parent plan can be located.
 */
export async function resolveParentPlan(
  repoRoot: string,
  opts: {
    plan?: string;
    selectFromAmbiguous?: (candidates: string[]) => Promise<string | undefined>;
    planRoot?: string;
  } = {},
): Promise<ResolvedParentPlan> {
  const resolvedPlanRoot = opts.planRoot ?? path.join(repoRoot, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  if (opts.plan) {
    // path.join strips relative-path noise but does NOT honor leading
    // slashes — `path.join("/repo", "ai_plan", "/abs/path")` yields
    // "/repo/ai_plan/abs/path", which is the bug a user hit when they
    // passed an absolute path. Use path.resolve when the input looks
    // like a path (contains a separator), and treat it as a slug
    // otherwise.
    const looksLikePath = opts.plan.includes("/") || opts.plan.includes(path.sep);
    const folder = looksLikePath
      ? path.resolve(repoRoot, opts.plan)
      : path.join(resolvedPlanRoot, opts.plan);
    const s = await stat(folder).catch(() => undefined);
    if (!s?.isDirectory()) {
      throw new Error(`sf_team_followup: --plan '${opts.plan}' not found at ${folder}`);
    }
    return { slug: path.basename(folder), folder };
  }
  const entries = await readdir(resolvedPlanRoot, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (candidates.length === 0) {
    throw new Error(`sf_team_followup: no plan folders found under ${resolvedPlanRoot}`);
  }
  if (candidates.length === 1) {
    return { slug: candidates[0], folder: path.join(resolvedPlanRoot, candidates[0]) };
  }
  if (opts.selectFromAmbiguous) {
    const picked = await opts.selectFromAmbiguous(candidates);
    if (picked) return { slug: picked, folder: path.join(resolvedPlanRoot, picked) };
  }
  // Default to the most recent (last-by-sort).
  const latest = candidates[candidates.length - 1];
  return { slug: latest, folder: path.join(resolvedPlanRoot, latest) };
}
