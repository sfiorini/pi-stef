/**
 * `ct status` subcommand implementation.
 *
 * Shows catalog status: profile, package counts (enabled/disabled),
 * installed/missing/orphan counts, gist URL, last sync time,
 * and individual package listing with setup status.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog, readLock } from "../config/io.js";
import { scanInstalled } from "../catalog/install.js";
import { readCachedGistId } from "../sync/cache.js";
import { checkSetupForSource } from "../catalog/setup.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `statusCommand`. Uses the base `CommandCtx`. */
export type StatusCtx = CommandCtx;

// ---------------------------------------------------------------------------
// statusCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct status` subcommand.
 *
 * Reads catalog, lock, gist cache, and installed packages to build
 * a comprehensive status summary with individual package listing.
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

  // --- Enabled / disabled counts ---
  let enabledCount = 0;
  let disabledCount = 0;
  for (const pkg of Object.values(packages)) {
    if (pkg.enabled === false) {
      disabledCount++;
    } else {
      enabledCount++;
    }
  }

  // --- Installed / missing / orphan ---
  // Build a lookup map for installed packages by source
  const installedBySource = new Map<string, { name: string; version?: string }>();
  for (const inst of Object.values(installed)) {
    installedBySource.set(inst.source, { name: inst.name, version: inst.version });
  }

  const catalogSources = new Set<string>();
  for (const pkg of Object.values(packages)) {
    catalogSources.add(pkg.source);
  }

  // Count how many catalog packages are actually installed
  let installedCount = 0;
  for (const pkg of Object.values(packages)) {
    if (installedBySource.has(pkg.source)) {
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
    `Packages: ${totalPackages} total (${enabledCount} enabled, ${disabledCount} disabled)`,
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

  // --- Individual package listing ---
  if (totalPackages > 0) {
    lines.push("");
    lines.push("Packages:");

    for (const [name, pkg] of Object.entries(packages)) {
      const isDisabled = pkg.enabled === false;
      const isInstalled = installedBySource.has(pkg.source);
      const inst = installedBySource.get(pkg.source);

      // Status indicator
      let status: string;
      if (isDisabled) {
        status = "disabled";
      } else if (isInstalled) {
        status = "installed";
      } else {
        status = "missing";
      }

      // Version info
      const versionStr = inst?.version ? ` v${inst.version}` : "";

      // Setup status
      let setupStr = "";
      if (isInstalled && !isDisabled) {
        const setup = checkSetupForSource(pkg.source, ctx.home);
        if (setup && !setup.ok) {
          setupStr = " ⚠ setup incomplete";
        }
      }

      lines.push(`  ${name} [${status}]${versionStr}${setupStr}`);
    }
  }

  // --- Orphans ---
  if (orphanCount > 0) {
    lines.push("");
    lines.push("Orphans:");
    for (const inst of Object.values(installed)) {
      if (!catalogSources.has(inst.source)) {
        const versionStr = inst.version ? ` v${inst.version}` : "";
        lines.push(`  ${inst.name} [orphan]${versionStr}`);
      }
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}
