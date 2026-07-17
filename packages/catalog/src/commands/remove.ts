/**
 * `ct remove` subcommand implementation.
 *
 * Removes a package from the catalog. Supports:
 *   - `ct remove <name>` — prompts for confirmation, then removes
 *   - `ct remove <name> --yes` — skips confirmation prompt
 *   - After removing from catalog, runs `pi uninstall <name>`
 *
 * Uses `removePackage` from `crud.ts` for catalog mutation,
 * and `writeCatalog` / `readCatalog` for persistence.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { reloadNotice } from "./types.js";
import { removePackage } from "../catalog/crud.js";
import { isPiStefSource } from "../catalog/packages.js";
import { readCatalog, writeCatalog, readLock, writeLock } from "../config/io.js";
import { recordRemoval } from "../catalog/removal-tombstones.js";
import { piUninstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `removeCommand`, extending the base with `confirm`. */
export interface RemoveCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// removeCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct remove` subcommand.
 *
 * Reads the catalog, confirms removal, removes the package,
 * writes the catalog, and runs `pi uninstall`.
 */
export async function removeCommand(
  args: CommandArgs,
  ctx: RemoveCtx,
): Promise<void> {
  const { positional, flags } = args;

  // --- Handle --scope batch mode ---------------------------------------------
  if ("scope" in flags) {
    const scope = flags["scope"];
    if (scope !== "@pi-stef") {
      ctx.ui.notify(`Unsupported scope: "${scope}". Use --scope @pi-stef.`, "error");
      return;
    }

    const catalog = readCatalog(ctx.home);
    const lock = readLock(ctx.home);

    // isPiStefSource returns false for @pi-stef/catalog by design (see packages.ts)
    const piStefNames = Object.keys(catalog.packages).filter(
      (name) => isPiStefSource(catalog.packages[name].source),
    );

    if (piStefNames.length === 0) {
      ctx.ui.notify("No @pi-stef packages found in catalog", "info");
      return;
    }

    // Confirmation
    const skipConfirm = "yes" in flags || "y" in flags;
    if (!skipConfirm && ctx.ui.confirm) {
      const confirmed = await ctx.ui.confirm(
        `Remove ${piStefNames.length} @pi-stef packages from catalog?`,
        "This uninstalls each package and removes all of them from the catalog.",
      );
      if (!confirmed) {
        ctx.ui.notify("Removal cancelled", "info");
        return;
      }
    }

    // Capture sources before removing
    const sources: Record<string, string> = {};
    for (const name of piStefNames) {
      sources[name] = catalog.packages[name].source;
    }

    // Remove all from catalog and lock file
    for (const name of piStefNames) {
      delete catalog.packages[name];
      if (lock.packages[name]) {
        delete lock.packages[name];
      }
    }

    writeCatalog(catalog, ctx.home);
    writeLock(lock, ctx.home);

    // Record removal tombstones so ct sync drops these from the remote
    for (const name of piStefNames) {
      recordRemoval(name, ctx.home);
    }

    // Uninstall all
    let uninstalled = 0;
    let failed = 0;
    for (const name of piStefNames) {
      ctx.ui.setWorkingMessage?.(`Uninstalling ${name} (${uninstalled + 1}/${piStefNames.length})...`);
      try {
        await piUninstall(sources[name]);
        uninstalled++;
      } catch {
        ctx.ui.notify(`Warning: uninstall of "${name}" failed`, "warning");
        failed++;
      }
    }
    ctx.ui.setWorkingMessage?.();

    ctx.ui.notify(
      `Scope @pi-stef: removed ${piStefNames.length}, uninstalled ${uninstalled}${failed > 0 ? ` (${failed} uninstall failed)` : ""}`,
      failed > 0 ? "warning" : "info",
    );

    // Reload extensions so removed tools disappear immediately
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
        "Packages removed. Restart pi for changes to take effect.",
        "warning",
      );
    }

    return;
  }

  const name = positional[0];

  // --- Validate required args -----------------------------------------------
  if (!name) {
    ctx.ui.notify("Usage: ct remove <name> [--yes]", "error");
    return;
  }

  // --- Read catalog ---------------------------------------------------------
  const catalog = readCatalog(ctx.home);

  // --- Validate package exists ----------------------------------------------
  if (!catalog.packages[name]) {
    ctx.ui.notify(`Package "${name}" not found`, "error");
    return;
  }

  // --- Confirmation (skip with --yes / -y) ----------------------------------
  const skipConfirm = "yes" in flags || "y" in flags;
  if (!skipConfirm) {
    if (ctx.ui.confirm) {
      const confirmed = await ctx.ui.confirm(
        `Remove package "${name}" from catalog?`,
        `This removes "${name}" from the catalog and runs pi uninstall.`,
      );
      if (!confirmed) {
        ctx.ui.notify("Removal cancelled", "info");
        return;
      }
    }
  }

  // --- Capture source before removing -------------------------------------
  // pi uninstall needs the full source (e.g., "npm:@pi-stef/foo"), not just
  // the catalog key.
  const source = catalog.packages[name].source;

  // --- Remove package -------------------------------------------------------
  const updated = removePackage(catalog, name);
  writeCatalog(updated, ctx.home);
  // Record the removal regardless of uninstall outcome — the catalog is the
  // source of truth and sync must not re-install this package even if the
  // disk-level uninstall fails (the user can always re-add and re-sync).
  recordRemoval(name, ctx.home);

  // --- Remove from lock file ------------------------------------------------
  const lock = readLock(ctx.home);
  if (lock.packages[name]) {
    delete lock.packages[name];
    writeLock(lock, ctx.home);
  }

  ctx.ui.notify(`Removed "${name}" from catalog`, "info");

  // --- Run pi uninstall -----------------------------------------------------
  ctx.ui.setWorkingMessage?.(`Uninstalling ${name}...`);
  let uninstallSucceeded = false;
  try {
    await piUninstall(source);
    uninstallSucceeded = true;
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" removed from catalog but uninstall failed`,
      "warning",
    );
  }
  ctx.ui.setWorkingMessage?.();

  // --- Reload extensions so removed tools disappear immediately --------------
  if (uninstallSucceeded && typeof ctx.reload === "function") {
    ctx.ui.notify("Reloading extensions...", "info");
    try {
      await ctx.reload();
      ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
    } catch {
      try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
    }
  } else {
    ctx.ui.notify(
      "Package removed. Restart pi for changes to take effect.",
      "warning",
    );
  }
}
