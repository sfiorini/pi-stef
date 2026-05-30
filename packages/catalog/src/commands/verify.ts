/**
 * `ct verify` subcommand implementation.
 *
 * Checks catalog integrity:
 *   - All packages have valid source formats (npm: or git: prefix)
 *   - Lock file entries match catalog packages
 *   - No stale lock entries (packages in lock but not in catalog)
 *   - Sync states are all "synced"
 *   - Detects orphan installed packages not tracked in catalog
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog, readLock } from "../config/io.js";
import { scanInstalled } from "../catalog/install.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `verifyCommand`. Uses the base `CommandCtx`. */
export type VerifyCtx = CommandCtx;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a source string is well-formed.
 * Accepted formats: npm:<package-name>, git:<url-or-path>
 */
function isValidSource(source: string): boolean {
  if (!source) return false;
  return /^npm:/.test(source) || /^git:/.test(source);
}

// ---------------------------------------------------------------------------
// verifyCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct verify` subcommand.
 *
 * Performs integrity checks on the catalog, lock file, and installed state.
 * Reports warnings for any issues found; reports success when all checks pass.
 */
export async function verifyCommand(
  _args: CommandArgs,
  ctx: VerifyCtx,
): Promise<void> {
  const catalog = readCatalog(ctx.home);
  const lock = readLock(ctx.home);
  const installed = scanInstalled(ctx.home);

  const packages = catalog.packages;
  const issues: string[] = [];

  // --- 1. Check source formats ---
  for (const [key, pkg] of Object.entries(packages)) {
    if (!isValidSource(pkg.source)) {
      issues.push(`Package "${key}" has invalid source: "${pkg.source}"`);
    }
  }

  // --- 2. Check catalog packages are present in lock ---
  for (const key of Object.keys(packages)) {
    if (!(key in lock.packages)) {
      issues.push(`Package "${key}" missing from lock file`);
    }
  }

  // --- 3. Check for stale lock entries ---
  for (const key of Object.keys(lock.packages)) {
    if (!(key in packages)) {
      issues.push(`Lock entry "${key}" not in catalog`);
    }
  }

  // --- 4. Check sync states ---
  for (const [key, lockPkg] of Object.entries(lock.packages)) {
    if (lockPkg.syncState !== "synced") {
      issues.push(
        `Package "${key}" has sync state "${lockPkg.syncState}" (expected "synced")`,
      );
    }
  }

  // --- 5. Check for orphan installed packages ---
  const catalogSources = new Set<string>();
  for (const pkg of Object.values(packages)) {
    catalogSources.add(pkg.source);
  }
  for (const [key, inst] of Object.entries(installed)) {
    if (!catalogSources.has(inst.source)) {
      issues.push(`Installed package "${key}" is an orphan (not in catalog)`);
    }
  }

  // --- Report ---
  const totalPackages = Object.keys(packages).length;

  if (issues.length === 0) {
    ctx.ui.notify(
      `All checks passed. ${totalPackages} package(s) verified.`,
      "info",
    );
  } else {
    // Report each issue as a warning
    for (const issue of issues) {
      ctx.ui.notify(issue, "warning");
    }
    ctx.ui.notify(
      `Verification complete: ${totalPackages} package(s) checked, ${issues.length} issue(s) found.`,
      "info",
    );
  }
}
