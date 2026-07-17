/**
 * `ct sync` subcommand implementation.
 *
 * Orchestrates the full sync cycle:
 *   1. Pull remote catalog from gist
 *   2. Reconcile local state with desired state
 *   3. Execute install/uninstall/upgrade actions
 *   4. Push updated catalog + lock to gist
 *
 * Supports `--dry-run` to preview the plan without executing.
 * Uses `--profile` flag to select the sync profile (default: "default").
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { reloadNotice } from "./types.js";
import type { CatalogYaml, LockFile } from "../config/schema.js";
import type { InstalledMap } from "../catalog/install.js";
import { readCatalog, writeCatalog, readLock, writeLock } from "../config/io.js";
import { pullCatalog } from "../sync/pull.js";
import { pushCatalog } from "../sync/push.js";
import { readCachedGistId } from "../sync/cache.js";
import { scanInstalled } from "../catalog/install.js";
import { applyRemovalTombstones, clearTombstones } from "../catalog/removal-tombstones.js";
import { reconcile, executeActions } from "../catalog/reconcile.js";
import { extractVersionFromSource } from "../catalog/source.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `syncCommand`, `pushCommand`, and `pullCommand`. */
export type SyncCtx = CommandCtx;

/** Alias used by push/pull test suite. */
export type PushPullCtx = CommandCtx;

/** Summary of a completed sync for user reporting. */
interface SyncSummary {
  pulled: boolean;
  /** Number of install/uninstall/upgrade actions. */
  actionCount: number;
  pushed: boolean;
  gistUrl?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// buildSyncedLock
// ---------------------------------------------------------------------------

/**
 * Build a populated lock file from the catalog and installed state.
 * Used when reconcile returns zero actions to ensure the lock file
 * carries real installed versions and timestamps.
 */
function buildSyncedLock(
  catalog: CatalogYaml,
  installed: InstalledMap,
): LockFile {
  const now = new Date().toISOString();
  const packages: LockFile["packages"] = {};

  for (const [key, pkg] of Object.entries(catalog.packages)) {
    if (pkg.enabled === false) continue;

    const sourceHash =
      "sha256-" +
      createHash("sha256").update(pkg.source).digest("hex").slice(0, 16);

    // Prefer installed version when available
    const installedPkg = Object.values(installed).find(
      (ip) => ip.source === pkg.source,
    );
    const version =
      installedPkg?.version ?? extractVersionFromSource(pkg.source);

    packages[key] = {
      version: version ?? "unknown",
      sourceHash,
      installedAt: now,
      syncState: "synced",
    };
  }

  return { packages };
}

// ---------------------------------------------------------------------------
// syncCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct sync` subcommand.
 *
 * Full sync cycle: pull → reconcile → execute → push.
 * With `--dry-run`, shows the plan without executing.
 */
export async function syncCommand(
  args: CommandArgs,
  ctx: SyncCtx,
): Promise<void> {
  const { flags } = args;
  const dryRun = "dry-run" in flags;
  const force = "force" in flags;
  const noPush = "no-push" in flags;
  const profile = typeof flags["profile"] === "string" ? flags["profile"] : "default";

  const summary: SyncSummary = {
    pulled: false,
    actionCount: 0,
    pushed: false,
    errors: [],
  };

  // --- 1. Read local state BEFORE pulling ---------------------------------
  // We need this to detect local-only packages and version changes
  // (e.g., from `pi update`) that haven't been pushed yet.
  const localCatalogBeforePull = readCatalog(ctx.home);
  const localLockBeforePull = readLock(ctx.home);

  // --- 2. Pull remote catalog (into memory only) ---------------------------
  let remoteCatalog = false;
  let pulledData: { catalog: CatalogYaml; lock: LockFile } | undefined;
  ctx.ui.setWorkingMessage?.("Pulling remote catalog...");
  try {
    pulledData = await pullCatalog(profile, ctx.home);
    remoteCatalog = true;
    summary.pulled = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Pull failed: ${message}`, "warning");
    summary.errors.push(message);
  }
  ctx.ui.setWorkingMessage?.();

  // --- 3. Reconcile --------------------------------------------------------
  // Use pulled catalog if available, otherwise read from disk
  let catalog = pulledData ? pulledData.catalog : readCatalog(ctx.home);

  // Merge local-only packages into the catalog.
  // When a user adds a package locally (ct add) and then syncs, the pull
  // would overwrite their addition. Detect local packages not in the remote
  // and merge them back so they get pushed.
  let hasLocalOnlyPackages = false;
  if (pulledData) {
    for (const [key, pkg] of Object.entries(localCatalogBeforePull.packages)) {
      if (!(key in catalog.packages)) {
        catalog.packages[key] = pkg;
        hasLocalOnlyPackages = true;
      }
    }
    // Apply local removal tombstones. When ct remove removes a package, it
    // writes a record to the removal-log so that ct sync can detect the
    // removal and drop the package from the pulled remote catalog (and push
    // the removal upstream). Without this, the remote would re-install it.
    // Gate on !dryRun to avoid clearing the tombstone log during a preview.
    if (!dryRun) {
      catalog = applyRemovalTombstones(catalog, ctx.home);
    }
  }

  // Detect local lock changes (e.g., from `pi update` bumping versions).
  // If the local lock has different versions than the remote lock, we need
  // to push so the remote gist reflects the actual installed state.
  let hasLocalLockChanges = false;
  if (pulledData) {
    const remoteLock = pulledData.lock;
    for (const [key, localEntry] of Object.entries(localLockBeforePull.packages)) {
      const remoteEntry = remoteLock.packages[key];
      if (!remoteEntry || remoteEntry.version !== localEntry.version) {
        hasLocalLockChanges = true;
        break;
      }
    }
    // Also check for packages in remote but removed locally
    if (!hasLocalLockChanges) {
      for (const key of Object.keys(remoteLock.packages)) {
        if (!(key in localLockBeforePull.packages)) {
          hasLocalLockChanges = true;
          break;
        }
      }
    }
  }

  // Track whether the rebuilt lock (from buildSyncedLock) differs from the
  // remote lock. This catches the case where `pi update` bumped an installed
  // version but the catalog source string hasn't changed, so the pre-pull
  // lock comparison wouldn't detect it.
  let rebuiltLockDiffers = false;

  const installed = scanInstalled(ctx.home);

  // Build catalog entries for reconcile
  const catalogEntries: Record<string, { source: string; enabled?: boolean }> = {};
  for (const [key, pkg] of Object.entries(catalog.packages)) {
    catalogEntries[key] = {
      source: pkg.source,
      enabled: pkg.enabled,
    };
  }

  const plan = reconcile(catalogEntries, installed);

  summary.actionCount =
    plan.installs.length +
    plan.uninstalls.length +
    plan.upgrades.length;

  // --- 3. Dry-run: show plan and stop --------------------------------------
  if (dryRun) {
    const parts: string[] = ["Dry run — no changes made."];
    if (plan.installs.length > 0) {
      parts.push(`Would install: ${plan.installs.map((a) => a.key).join(", ")}`);
    }
    if (plan.uninstalls.length > 0) {
      parts.push(`Would uninstall: ${plan.uninstalls.map((a) => a.key).join(", ")}`);
    }
    if (plan.upgrades.length > 0) {
      parts.push(`Would upgrade: ${plan.upgrades.map((a) => a.key).join(", ")}`);
    }
    if (plan.orphans.length > 0) {
      parts.push(`Orphans: ${plan.orphans.map((o) => o.key).join(", ")}`);
    }
    if (summary.actionCount === 0 && plan.orphans.length === 0) {
      parts.push("No changes needed.");
    }
    ctx.ui.notify(parts.join("\n"), "info");
    return;
  }

  // --- 4. Execute actions --------------------------------------------------
  if (summary.actionCount > 0) {
    // Write pulled catalog to disk before executing actions (pull-then-execute)
    if (pulledData) {
      writeCatalog(pulledData.catalog, ctx.home);
      writeLock(pulledData.lock, ctx.home);
    }

    ctx.ui.setWorkingMessage?.("Executing actions...");
    const result = await executeActions(plan, { home: ctx.home });
    ctx.ui.setWorkingMessage?.();

    for (const { error } of result.errors) {
      ctx.ui.notify(`Action error: ${error.message}`, "warning");
      summary.errors.push(error.message);
    }
  } else {
    // No actions needed — write catalog (pulled or local) and build/populate lock
    if (pulledData) {
      writeCatalog(pulledData.catalog, ctx.home);
    }
    // Always write a populated lock so "last sync" is accurate
    const syncedLock = buildSyncedLock(catalog, installed);
    writeLock(syncedLock, ctx.home);

    // Compare rebuilt lock versions against remote to detect version drift
    // from external `pi update` calls that bumped installed versions without
    // changing the catalog source string.
    if (pulledData) {
      const remoteLock = pulledData.lock;
      for (const [key, rebuiltEntry] of Object.entries(syncedLock.packages)) {
        const remoteEntry = remoteLock.packages[key];
        if (!remoteEntry || remoteEntry.version !== rebuiltEntry.version) {
          rebuiltLockDiffers = true;
          break;
        }
      }
      if (!rebuiltLockDiffers) {
        for (const key of Object.keys(remoteLock.packages)) {
          if (!(key in syncedLock.packages)) {
            rebuiltLockDiffers = true;
            break;
          }
        }
      }
    }
  }

  // --- 5. Push if changed --------------------------------------------------
  if (noPush) {
    // --no-push: skip push and report
    if (summary.actionCount > 0 && summary.errors.length === 0) {
      ctx.ui.notify(
        `Synced locally (${summary.actionCount} action(s)). Push skipped (--no-push).`,
        "info",
      );
    }
    return;
  }

  const hasGist = readCachedGistId(ctx.home) !== undefined;
  const localHasPackages = Object.keys(catalog.packages).length > 0;

  if (force || summary.actionCount > 0 || hasLocalOnlyPackages || hasLocalLockChanges || rebuiltLockDiffers || (!hasGist && localHasPackages)) {
    ctx.ui.setWorkingMessage?.("Pushing to gist...");
    try {
      const updatedCatalog = readCatalog(ctx.home);
      const updatedLock = readLock(ctx.home);
      const pushResult = await pushCatalog(
        updatedCatalog,
        updatedLock,
        profile,
        ctx.home,
      );
      summary.pushed = true;
      summary.gistUrl = pushResult.gistUrl;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Push failed: ${message}`, "error");
      summary.errors.push(message);
    }
    ctx.ui.setWorkingMessage?.();
  }

  // --- 6. Report summary ---------------------------------------------------
  if (summary.errors.length > 0 && !summary.pushed && !remoteCatalog) {
    // All errors, no success — first-time message
    if (!hasGist && !localHasPackages) {
      ctx.ui.notify(
        "No remote gist found and local catalog is empty. Use `ct add` to add packages, then `ct sync` to push.",
        "info",
      );
      return;
    }
  }

  if (summary.actionCount === 0 && summary.errors.length === 0 && !force && !hasLocalOnlyPackages && !hasLocalLockChanges && !rebuiltLockDiffers) {
    ctx.ui.notify("Catalog already up to date.", "info");
    return;
  }

  // Build detailed summary
  const parts: string[] = [];
  if (summary.pulled) {
    parts.push("Pulled remote catalog.");
  }
  if (hasLocalOnlyPackages) {
    parts.push("Merged local-only packages.");
  }
  if (hasLocalLockChanges) {
    parts.push("Pushed local version updates.");
  }
  if (rebuiltLockDiffers) {
    parts.push("Rebuilt lock (version drift detected).");
  }
  if (plan.installs.length > 0) {
    parts.push(`${plan.installs.length} install(s): ${plan.installs.map((a) => a.key).join(", ")}`);
  }
  if (plan.uninstalls.length > 0) {
    parts.push(`${plan.uninstalls.length} uninstall(s): ${plan.uninstalls.map((a) => a.key).join(", ")}`);
  }
  if (plan.upgrades.length > 0) {
    parts.push(`${plan.upgrades.length} upgrade(s): ${plan.upgrades.map((a) => a.key).join(", ")}`);
  }
  if (summary.pushed) {
    parts.push(`Pushed to gist: ${summary.gistUrl}`);
  }
  if (summary.errors.length > 0) {
    parts.push(`${summary.errors.length} error(s) encountered.`);
  }

  ctx.ui.notify(`Synced: ${parts.join(" | ")}`, "info");

  // Reload extensions so synced package changes take effect immediately
  if (summary.actionCount > 0 && typeof ctx.reload === "function") {
    ctx.ui.notify("Reloading extensions...", "info");
    try {
      await ctx.reload();
      ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
    } catch {
      try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
    }
  } else if (summary.actionCount > 0) {
    ctx.ui.notify(
      "Sync complete. Restart pi for changes to take effect.",
      "warning",
    );
  }
}

// ---------------------------------------------------------------------------
// pushCommand  (ct push)
// ---------------------------------------------------------------------------

/**
 * Execute the `ct push` subcommand.
 *
 * Reads the local catalog + lock and pushes them to a GitHub Gist.
 * Reports the gist URL on success.
 */
export async function pushCommand(
  args: CommandArgs,
  ctx: PushPullCtx,
): Promise<void> {
  const { flags } = args;
  const profile = typeof flags["profile"] === "string" ? flags["profile"] : "default";

  const catalog = readCatalog(ctx.home);
  const lock = readLock(ctx.home);

  // --- --dry-run: show what would be pushed without uploading -------------
  if ("dry-run" in flags) {
    const pkgCount = Object.keys(catalog.packages).length;
    ctx.ui.notify(
      `Dry run — would push ${pkgCount} package(s) to gist (profile: ${profile}).`,
      "info",
    );
    return;
  }

  try {
    const result = await pushCatalog(catalog, lock, profile, ctx.home);
    ctx.ui.notify(`Pushed to gist: ${result.gistUrl}`, "info");
    // Propagates the removal upstream — tombstones have served their purpose.
    clearTombstones(ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Push failed: ${message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// pullCommand  (ct pull)
// ---------------------------------------------------------------------------

/**
 * Execute the `ct pull` subcommand.
 *
 * Pulls the remote catalog from gist, writes it locally, then reconciles
 * and executes any needed install/uninstall/upgrade actions.
 */
export async function pullCommand(
  args: CommandArgs,
  ctx: PushPullCtx,
): Promise<void> {
  const { flags } = args;
  const profile = typeof flags["profile"] === "string" ? flags["profile"] : "default";

  let pulledCatalog: CatalogYaml;
  let pulledLock: LockFile;

  // --- 1. Pull remote catalog ----------------------------------------------
  try {
    const result = await pullCatalog(profile, ctx.home);
    pulledCatalog = result.catalog;
    pulledLock = result.lock;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Pull failed: ${message}`, "error");
    return;
  }

  // --- Reconcile against the pulled catalog ------------------------------
  const catalogEntries: Record<string, { source: string; enabled?: boolean }> = {};
  for (const [key, pkg] of Object.entries(pulledCatalog.packages)) {
    catalogEntries[key] = {
      source: pkg.source,
      enabled: pkg.enabled,
    };
  }

  const installed = scanInstalled(ctx.home);
  const plan = reconcile(catalogEntries, installed);

  const actionCount =
    plan.installs.length +
    plan.uninstalls.length +
    plan.upgrades.length;

  // --- --dry-run: show plan without writing or executing -------------------
  if ("dry-run" in flags) {
    if (actionCount === 0) {
      ctx.ui.notify("Dry run — pulled remote catalog. No changes needed.", "info");
    } else {
      const parts: string[] = ["Dry run — pulled remote catalog. Would execute:"];
      if (plan.installs.length > 0) {
        parts.push(`Would install: ${plan.installs.map((a) => a.key).join(", ")}`);
      }
      if (plan.uninstalls.length > 0) {
        parts.push(`Would uninstall: ${plan.uninstalls.map((a) => a.key).join(", ")}`);
      }
      if (plan.upgrades.length > 0) {
        parts.push(`Would upgrade: ${plan.upgrades.map((a) => a.key).join(", ")}`);
      }
      ctx.ui.notify(parts.join(" "), "info");
    }
    return;
  }

  // --- 2. Write pulled catalog locally ------------------------------------
  writeCatalog(pulledCatalog, ctx.home);
  writeLock(pulledLock, ctx.home);

  // --- 3. Execute actions -------------------------------------------------
  if (actionCount > 0) {
    const result = await executeActions(plan, { home: ctx.home });

    for (const { error } of result.errors) {
      ctx.ui.notify(`Action error: ${error.message}`, "warning");
    }

    // Build summary
    const parts: string[] = ["Pulled remote catalog."];
    if (plan.installs.length > 0) {
      parts.push(`${plan.installs.length} install(s): ${plan.installs.map((a) => a.key).join(", ")}`);
    }
    if (plan.uninstalls.length > 0) {
      parts.push(`${plan.uninstalls.length} uninstall(s): ${plan.uninstalls.map((a) => a.key).join(", ")}`);
    }
    if (plan.upgrades.length > 0) {
      parts.push(`${plan.upgrades.length} upgrade(s): ${plan.upgrades.map((a) => a.key).join(", ")}`);
    }
    if (result.errors.length > 0) {
      parts.push(`${result.errors.length} error(s).`);
    }
    ctx.ui.notify(parts.join(" | "), "info");

    // Reload extensions so pulled package changes take effect immediately
    if (typeof ctx.reload === "function") {
      ctx.ui.notify("Reloading extensions...", "info");
      try {
        await ctx.reload();
        ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
      } catch {
        try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
      }
    } else {
      ctx.ui.notify(
        "Pull complete. Restart pi for changes to take effect.",
        "warning",
      );
    }
  } else {
    ctx.ui.notify("Pulled: catalog is up to date.", "info");
  }
}
