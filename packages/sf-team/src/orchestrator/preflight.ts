import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { resolveSkillPath } from "../runtime/resolve-skill";

export interface PreflightResult {
  resolved: { name: string; path: string }[];
  missing: string[];
}

export interface PreflightOptions {
  ui?: Pick<ExtensionUIContext, "confirm" | "notify"> | undefined;
  /** Test-only override of resolveSkillPath. */
  resolve?: (name: string) => string | undefined;
  /** Pi default config dirs (homeDir + repoRoot) for resolveSkillPath. */
  homeDir?: string;
  repoRoot?: string;
  extraRoots?: string[];
}

/**
 * Pre-flight skill check (warn-on-missing).
 *
 * For each requested skill, attempt to resolve it on disk. Missing skills
 * are reported via pi.ui.notify (when UI is available) and do NOT block —
 * locked plan decision #5/#9: warn-and-continue.
 *
 * Returns the resolved paths (so the caller can pass them as `--skill <path>`
 * to spawnAgent) and the list of missing names (already warned about).
 */
export async function preflightSkillCheck(
  allowlist: string[],
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const resolver = opts.resolve ?? ((name: string) => resolveSkillPath(name, {
    homeDir: opts.homeDir,
    repoRoot: opts.repoRoot,
    extraRoots: opts.extraRoots,
  }));
  const resolved: { name: string; path: string }[] = [];
  const missing: string[] = [];
  for (const name of allowlist) {
    const path = resolver(name);
    if (path) resolved.push({ name, path });
    else missing.push(name);
  }
  if (missing.length > 0 && opts.ui?.notify) {
    opts.ui.notify(`sf-team: skills not found, continuing without them: ${missing.join(", ")}`, "warning");
  }
  return { resolved, missing };
}
