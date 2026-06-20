import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { CommandCtx } from "../commands/types.js";
import { readCatalog } from "../config/io.js";
import { piInstall } from "../util/exec.js";
import { resolveInstalledDir } from "./install.js";

/** Maximum companion recursion depth (3 hops) to bound chains and prevent runaway installs. */
export const MAX_COMPANION_DEPTH = 3;

/**
 * Companion-package resolution for the catalog.
 *
 * A package may declare required companion sources in its own
 * `package.json` under `pi.companions` (a string array of npm:/git: sources).
 * When the catalog installs such a package it also installs each companion
 * that is not already installed.
 */

/** A parsed package.json-shaped object (only the fields we read). */
export interface PackageManifest {
  name?: string;
  pi?: {
    companions?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Extract the list of companion source strings from a package manifest.
 * Returns an empty array when none are declared or the shape is invalid.
 * Non-string and empty entries are filtered out (defensive).
 */
export function readCompanionsFromManifest(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const pi = (manifest as PackageManifest).pi;
  if (!pi || typeof pi !== "object") return [];
  const raw = (pi as { companions?: unknown }).companions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && c.length > 0);
}

/**
 * Resolve the companion sources declared by an installed package that are
 * not already installed. Pure function of the installed directory.
 *
 * @param installedDir Absolute path to the installed package directory
 *   (the dir containing its package.json).
 * @param alreadyInstalled Sources already installed (excluded).
 * @returns De-duplicated, ordered list of companion source strings to install.
 */
export function resolveCompanions(
  installedDir: string,
  alreadyInstalled: ReadonlySet<string>,
): string[] {
  const manifestPath = join(installedDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const all = readCompanionsFromManifest(manifest);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of all) {
    if (alreadyInstalled.has(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Install companions declared in the installed package manifest via BFS.
 *
 * Reads `pi.companions` from the installed package's `package.json` and
 * installs each companion that is not already in the catalog or already
 * visited. Traverses transitively (companions may declare their own
 * companions) up to `MAX_COMPANION_DEPTH` levels. Companion install failures
 * are warnings — they never fail the caller.
 *
 * Used by both `ct add` and `ct update` after the primary install/update
 * succeeds. Skipped silently when `ctx.home` is unavailable.
 *
 * @param source The primary package source string that was installed/updated.
 * @param ctx The command context (provides home dir + UI hooks).
 */
export async function installCompanions(
  source: string,
  ctx: CommandCtx,
): Promise<void> {
  if (!ctx.home) {
    ctx.ui.notify?.("Cannot resolve companions: catalog home directory is not available.", "warning");
    return;
  }
  const rootDir = resolveInstalledDir(source, ctx.home);
  if (!rootDir) {
    ctx.ui.notify?.(
      `Cannot resolve companions for "${source}": unable to determine installed directory (only npm sources can resolve companions).`,
      "warning",
    );
    return;
  }

  const visited = new Set<string>([source]);
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth >= MAX_COMPANION_DEPTH) continue;
    const catalogSources = new Set(
      Object.values(readCatalog(ctx.home).packages).map((p) => p.source),
    );
    for (const c of resolveCompanions(dir, new Set([...visited, ...catalogSources]))) {
      if (visited.has(c)) continue;
      visited.add(c);
      ctx.ui.setWorkingMessage?.(`Installing companion ${c}...`);
      try {
        await piInstall(c);
        ctx.ui.notify(`Installed companion "${c}"`, "info");
      } catch {
        ctx.ui.notify(`Warning: companion "${c}" install failed`, "warning");
      }
      const cdir = resolveInstalledDir(c, ctx.home);
      if (cdir) queue.push({ dir: cdir, depth: depth + 1 });
    }
  }
  ctx.ui.setWorkingMessage?.();
}
