/**
 * `ct status` subcommand implementation.
 *
 * Shows catalog status: profile, package counts by rating,
 * installed/missing/orphan counts, gist URL, and last sync time.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog, readLock } from "../config/io.js";
import { scanInstalled } from "../catalog/install.js";
import { readCachedGistId } from "../sync/cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `statusCommand`. Uses the base `CommandCtx`. */
export type StatusCtx = CommandCtx;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RatingCounts {
  core: number;
  useful: number;
  debatable: number;
  disabled: number;
}

function countByRating(
  packages: Record<string, { rating: string; enabled?: boolean }>,
): RatingCounts {
  const counts: RatingCounts = { core: 0, useful: 0, debatable: 0, disabled: 0 };
  for (const pkg of Object.values(packages)) {
    const r = pkg.rating as keyof RatingCounts;
    if (r in counts) {
      counts[r]++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// statusCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct status` subcommand.
 *
 * Reads catalog, lock, gist cache, and installed packages to build
 * a comprehensive status summary.
 */
export async function statusCommand(
  args: CommandArgs,
  ctx: StatusCtx,
): Promise<void> {
  const { flags } = args;
  const profile =
    typeof flags["profile"] === "string" ? flags["profile"] : "default";

  const catalog = readCatalog(ctx.home);
  const lock = readLock(ctx.home);
  const installed = scanInstalled(ctx.home);
  const gistId = readCachedGistId(ctx.home);

  const packages = catalog.packages;
  const totalPackages = Object.keys(packages).length;

  // --- Package counts by rating ---
  const ratingCounts = countByRating(packages);

  // --- Installed / missing / orphan ---
  const catalogSources = new Set<string>();
  for (const pkg of Object.values(packages)) {
    catalogSources.add(pkg.source);
  }

  const installedSources = new Set<string>();
  for (const inst of Object.values(installed)) {
    installedSources.add(inst.source);
  }

  // Count how many catalog packages are actually installed
  let installedCount = 0;
  for (const pkg of Object.values(packages)) {
    if (installedSources.has(pkg.source)) {
      installedCount++;
    }
  }

  // Missing = catalog packages not installed
  const missingCount = totalPackages - installedCount;

  // Orphans = installed packages not in catalog
  let orphanCount = 0;
  for (const inst of Object.values(installed)) {
    if (!catalogSources.has(inst.source)) {
      orphanCount++;
    }
  }

  // --- Last sync time ---
  let lastSync: string | undefined;
  for (const lockPkg of Object.values(lock.packages)) {
    if (!lastSync || lockPkg.installedAt > lastSync) {
      lastSync = lockPkg.installedAt;
    }
  }

  // --- Build status message ---
  const lines: string[] = [];

  // Profile
  lines.push(`Profile: ${profile}`);

  // Package counts
  lines.push(
    `Packages: ${totalPackages} total (core: ${ratingCounts.core}, useful: ${ratingCounts.useful}, debatable: ${ratingCounts.debatable}, disabled: ${ratingCounts.disabled})`,
  );

  // Installed/missing/orphan
  lines.push(
    `Installed: ${installedCount}, Missing: ${missingCount}, Orphans: ${orphanCount}`,
  );

  // Gist URL
  if (gistId) {
    lines.push(`Gist: https://gist.github.com/${gistId}`);
  } else {
    lines.push("No remote gist configured");
  }

  // Last sync
  if (lastSync) {
    lines.push(`Last sync: ${lastSync}`);
  } else {
    lines.push("Last sync: never synced");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}
