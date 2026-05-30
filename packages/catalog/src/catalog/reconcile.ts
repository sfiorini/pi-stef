/**
 * Reconciliation engine for catalog packages.
 *
 * S-303: reconcile(catalog, installed, options?) compares the desired catalog
 * state against currently installed packages and returns a ReconcilePlan with
 * install, uninstall, upgrade actions and orphan reports.
 *
 * executeActions(plan, options?) runs the shell commands via piInstall /
 * piUninstall and updates the lock file on success.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { piInstall, piUninstall } from "../util/exec.js";
import { lockFile } from "../config/paths.js";
import type { LockFile } from "../config/schema.js";
import type { InstalledMap } from "./install.js";
import {
  sourceToKey,
  extractNpmVersion,
  extractVersionFromSource,
} from "./source.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A catalog entry as consumed by reconcile. */
export interface CatalogEntry {
  /** Source string (e.g. "npm:@foo/bar@1.0.0", "git:github.com/user/repo"). */
  source: string;
  /** Whether the package should be managed. Defaults to true when absent. */
  enabled?: boolean;
}

export interface InstallAction {
  type: "install";
  /** Catalog key for the package. */
  key: string;
  source: string;
}

export interface UninstallAction {
  type: "uninstall";
  /** Installed-map key to uninstall. */
  key: string;
  source: string;
}

export interface UpgradeAction {
  type: "upgrade";
  /** Installed-map key. */
  key: string;
  source: string;
  currentVersion?: string;
  targetVersion?: string;
}

export interface OrphanReport {
  /** Installed-map key of the orphan package. */
  key: string;
  source: string;
  version?: string;
}

export interface ReconcilePlan {
  installs: InstallAction[];
  uninstalls: UninstallAction[];
  upgrades: UpgradeAction[];
  orphans: OrphanReport[];
}

export interface ReconcileOptions {
  /** If true, uninstall actions are also generated for orphans. */
  removeOrphans?: boolean;
}

export interface ActionError {
  action: InstallAction | UninstallAction | UpgradeAction;
  error: Error;
}

export interface ExecuteResult {
  success: boolean;
  errors: ActionError[];
}

export interface ExecuteOptions {
  /** Home directory override (for lock file path). */
  home?: string;
  /** Lock file writer override (for testing). Defaults to fs.writeFileSync. */
  lockFileWriter?: (filePath: string, content: string) => void;
  /** If true, skip actual shell execution and lock file writes. Returns success with no errors. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** Returns true when the plan contains at least one action. */
function hasActions(plan: ReconcilePlan): boolean {
  return (
    plan.installs.length > 0 ||
    plan.uninstalls.length > 0 ||
    plan.upgrades.length > 0
  );
}

// ---------------------------------------------------------------------------
// Lock-file helpers
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic content hash from a source string.
 *
 * NOTE: This hashes the *source specifier*, not the installed file contents.
 * A future milestone should replace this with actual content hashing after
 * extraction.
 */
function contentHashForSource(source: string): string {
  return (
    "sha256-" +
    createHash("sha256").update(source).digest("hex").slice(0, 16)
  );
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

/**
 * Compare the desired catalog state against currently installed packages
 * and produce a plan of actions.
 *
 * @param catalog  Map of catalog keys to entries (from cat.yaml).
 * @param installed  Map of installed keys to package info (from scanInstalled).
 * @param options  Optional flags controlling orphan handling.
 */
export function reconcile(
  catalog: Record<string, CatalogEntry>,
  installed: InstalledMap,
  options?: ReconcileOptions,
): ReconcilePlan {
  const plan: ReconcilePlan = {
    installs: [],
    uninstalls: [],
    upgrades: [],
    orphans: [],
  };

  // Track which installed keys are referenced by at least one catalog entry
  const matchedInstalledKeys = new Set<string>();

  // --- Process catalog entries ---
  for (const [catKey, entry] of Object.entries(catalog)) {
    const isEnabled = entry.enabled !== false;
    const installedKey = sourceToKey(entry.source);
    const installedPkg = installed[installedKey];

    if (installedPkg) {
      matchedInstalledKeys.add(installedKey);

      if (!isEnabled) {
        // Disabled + installed → uninstall
        plan.uninstalls.push({
          type: "uninstall",
          key: installedKey,
          source: entry.source,
        });
      } else {
        // Enabled + installed → check for upgrade
        const sourcesDiffer = installedPkg.source !== entry.source;

        if (sourcesDiffer) {
          const isNpm = entry.source.startsWith("npm:");
          const targetVersion = isNpm
            ? extractNpmVersion(entry.source.slice(4))
            : undefined;
          const currentVersion = installedPkg.version;

          // For npm without version pin, don't upgrade (already installed)
          const isVersionlessNpm = isNpm && targetVersion === undefined;

          if (!isVersionlessNpm) {
            plan.upgrades.push({
              type: "upgrade",
              key: installedKey,
              source: entry.source,
              currentVersion,
              targetVersion,
            });
          }
        }
        // If sources match → no action needed
      }
    } else {
      // Not installed
      if (isEnabled) {
        plan.installs.push({
          type: "install",
          key: catKey,
          source: entry.source,
        });
      }
      // Not installed + disabled → no action
    }
  }

  // --- Detect orphans (installed but not in catalog) ---
  for (const [installedKey, installedPkg] of Object.entries(installed)) {
    if (!matchedInstalledKeys.has(installedKey)) {
      plan.orphans.push({
        key: installedKey,
        source: installedPkg.source,
        version: installedPkg.version,
      });

      if (options?.removeOrphans) {
        plan.uninstalls.push({
          type: "uninstall",
          key: installedKey,
          source: installedPkg.source,
        });
      }
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// executeActions
// ---------------------------------------------------------------------------

export async function executeActions(
  plan: ReconcilePlan,
  options?: ExecuteOptions,
): Promise<ExecuteResult> {
  const errors: ActionError[] = [];

  // --- Dry-run: preview mode, skip execution and lock file write ---
  if (options?.dryRun) {
    return { success: true, errors };
  }

  // --- Uninstalls first ---
  for (const action of plan.uninstalls) {
    try {
      await piUninstall(action.key);
    } catch (err) {
      errors.push({
        action,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // --- Installs ---
  for (const action of plan.installs) {
    try {
      await piInstall(action.source);
    } catch (err) {
      errors.push({
        action,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // --- Upgrades (reinstall) ---
  for (const action of plan.upgrades) {
    try {
      await piInstall(action.source);
    } catch (err) {
      errors.push({
        action,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const success = errors.length === 0;

  // Write lock file only on full success and when there were actions
  if (success && hasActions(plan)) {
    const lfPath = lockFile(options?.home);

    // Read existing lock to preserve entries not touched in this run
    let existingPackages: LockFile["packages"] = {};
    try {
      const raw = fs.readFileSync(lfPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.packages && typeof parsed.packages === "object") {
        existingPackages = parsed.packages;
      }
    } catch {
      // No existing lock or malformed — start fresh
    }

    const lockPackages = { ...existingPackages };
    const now = new Date().toISOString();

    // Add/update entries for successful installs
    for (const action of plan.installs) {
      lockPackages[action.key] = {
        version: extractVersionFromSource(action.source),
        contentHash: contentHashForSource(action.source),
        installedAt: now,
        syncState: "synced",
      };
    }

    // Add/update entries for successful upgrades
    for (const action of plan.upgrades) {
      lockPackages[action.key] = {
        version: extractVersionFromSource(action.source),
        contentHash: contentHashForSource(action.source),
        installedAt: now,
        syncState: "synced",
      };
    }

    // Remove entries for successful uninstalls
    for (const action of plan.uninstalls) {
      delete lockPackages[action.key];
    }

    const lockContent =
      JSON.stringify({ packages: lockPackages }, null, 2) + "\n";

    const writer =
      options?.lockFileWriter ??
      ((p, c) => fs.writeFileSync(p, c, "utf-8"));
    writer(lfPath, lockContent);
  }

  return { success, errors };
}
