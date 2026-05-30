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
import { removePackage } from "../catalog/crud.js";
import { readCatalog, writeCatalog } from "../config/io.js";
import { piUninstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `removeCommand`, extending the base with `confirm`. */
export interface RemoveCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    confirm?: (message: string) => Promise<boolean>;
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
      );
      if (!confirmed) {
        ctx.ui.notify("Removal cancelled", "info");
        return;
      }
    }
  }

  // --- Remove package -------------------------------------------------------
  const updated = removePackage(catalog, name);
  writeCatalog(updated, ctx.home);

  ctx.ui.notify(`Removed "${name}" from catalog`, "info");

  // --- Run pi uninstall -----------------------------------------------------
  try {
    await piUninstall(name);
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" removed from catalog but uninstall failed`,
      "warning",
    );
  }
}
