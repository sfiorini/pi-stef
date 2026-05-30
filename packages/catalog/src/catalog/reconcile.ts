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
import { piInstall, piUninstall } from "../util/exec.js";
import { lockFile } from "../config/paths.js";
import type { InstalledMap } from "./install.js";

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
// Source-key derivation (mirrors install.ts parseSource key logic)
// ---------------------------------------------------------------------------

/**
 * Derive the installed-map key from a source string.
 *
 * - npm sources → npm package name (e.g. "@foo/bar")
 * - git sources → cleaned host/path (e.g. "github.com/user/repo")
 * - local paths → the raw source string itself
 */
function sourceToKey(source: string): string {
  if (source.startsWith("npm:")) {
    return extractNpmName(source.slice(4));
  }
  if (source.startsWith("git:")) {
    return cleanGitName(source.slice(4));
  }
  if (
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://")
  ) {
    return cleanGitName(source);
  }
  // Local path — key is the raw source itself (matches scanInstalled behavior)
  return source;
}

/**
 * Extract the npm package name from "pkg@version" or "@scope/pkg@version".
 */
function extractNpmName(spec: string): string {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? spec : spec.slice(0, secondAt);
  }
  const atIdx = spec.indexOf("@");
  return atIdx === -1 ? spec : spec.slice(0, atIdx);
}

/**
 * Extract version from an npm spec (the part after the last relevant @).
 */
function extractNpmVersion(spec: string): string | undefined {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? undefined : spec.slice(secondAt + 1);
  }
  const atIdx = spec.indexOf("@");
  return atIdx === -1 ? undefined : spec.slice(atIdx + 1);
}

/**
 * Clean a git/URL source into a canonical host/path name.
 * Mirrors the logic in install.ts extractGitName.
 */
function cleanGitName(raw: string): string {
  let cleaned = raw;
  cleaned = cleaned.replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)/, "");
  cleaned = cleaned.replace(/^[^@/]+@/, "");
  cleaned = cleaned.replace(/:/, "/");
  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx !== -1) {
    cleaned = cleaned.slice(0, atIdx);
  }
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }
  return cleaned;
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

  // Write lock file only on full success
  if (success && (plan.installs.length + plan.uninstalls.length + plan.upgrades.length > 0)) {
    const lfPath = lockFile(options?.home);
    const lockContent = JSON.stringify(
      {
        packages: {},
      },
      null,
      2,
    );
    const writer = options?.lockFileWriter ?? ((p, c) => fs.writeFileSync(p, c, "utf-8"));
    writer(lfPath, lockContent);
  }

  return { success, errors };
}
