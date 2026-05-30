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
import type { CatalogYaml, LockFile } from "../config/schema.js";
import { readCatalog, writeCatalog, readLock, writeLock } from "../config/io.js";
import { pullCatalog } from "../sync/pull.js";
import { pushCatalog } from "../sync/push.js";
import { readCachedGistId } from "../sync/cache.js";
import { scanInstalled } from "../catalog/install.js";
import { reconcile, executeActions } from "../catalog/reconcile.js";

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

  // --- 1. Pull remote catalog ----------------------------------------------
  let remoteCatalog = false;
  try {
    const pulled = await pullCatalog(profile, ctx.home);
    remoteCatalog = true;
    summary.pulled = true;

    // Write the pulled catalog as the local catalog
    writeCatalog(pulled.catalog, ctx.home);
    writeLock(pulled.lock, ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Pull failed: ${message}`, "warning");
    summary.errors.push(message);
  }

  // --- 2. Reconcile --------------------------------------------------------
  const catalog = readCatalog(ctx.home);
  const lock = readLock(ctx.home);
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
    const result = await executeActions(plan, { home: ctx.home });

    for (const { error } of result.errors) {
      ctx.ui.notify(`Action error: ${error.message}`, "warning");
      summary.errors.push(error.message);
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

  if (force || summary.actionCount > 0 || (!hasGist && localHasPackages)) {
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

  if (summary.actionCount === 0 && summary.errors.length === 0 && !force) {
    ctx.ui.notify("Catalog already up to date.", "info");
    return;
  }

  // Build detailed summary
  const parts: string[] = [];
  if (summary.pulled) {
    parts.push("Pulled remote catalog.");
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

  try {
    const result = await pushCatalog(catalog, lock, profile, ctx.home);
    ctx.ui.notify(`Pushed to gist: ${result.gistUrl}`, "info");
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

  // --- 2. Write pulled catalog locally ------------------------------------
  writeCatalog(pulledCatalog, ctx.home);
  writeLock(pulledLock, ctx.home);

  // --- 3. Reconcile -------------------------------------------------------
  const catalog = readCatalog(ctx.home);
  const installed = scanInstalled(ctx.home);

  const catalogEntries: Record<string, { source: string; enabled?: boolean }> = {};
  for (const [key, pkg] of Object.entries(catalog.packages)) {
    catalogEntries[key] = {
      source: pkg.source,
      enabled: pkg.enabled,
    };
  }

  const plan = reconcile(catalogEntries, installed);

  const actionCount =
    plan.installs.length +
    plan.uninstalls.length +
    plan.upgrades.length;

  // --- 4. Execute actions -------------------------------------------------
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
  } else {
    ctx.ui.notify("Pulled: catalog is up to date.", "info");
  }
}
