/**
 * `ct update` subcommand implementation.
 *
 * Updates packages to their latest versions by running `pi update <source>`.
 *
 * Usage:
 *   - `ct update <name>` — update a single package by catalog name
 *   - `ct update --all` — update all packages in the catalog
 *
 * After updating, a `/ct sync` should be run to persist changes to the remote gist.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { reloadNotice } from "./types.js";
import { readCatalog } from "../config/io.js";
import { piUpdate } from "../util/exec.js";
import { checkSetupForSource, formatSetupStatus } from "../catalog/setup.js";
import { installCompanions } from "../catalog/companions.js";

// ---------------------------------------------------------------------------
// updateCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct update` subcommand.
 *
 * Reads the catalog, resolves the target package(s), and runs
 * `pi update <source>` for each.
 */
export async function updateCommand(
  args: CommandArgs,
  ctx: CommandCtx,
): Promise<void> {
  const { positional, flags } = args;
  const updateAll = "all" in flags;
  const name = positional[0];

  if (!name && !updateAll) {
    ctx.ui.notify("Usage: ct update <name> | ct update --all", "error");
    return;
  }

  const catalog = readCatalog(ctx.home);
  const packages = catalog.packages;

  // --- Single package update ------------------------------------------------
  if (name) {
    const entry = packages[name];
    if (!entry) {
      ctx.ui.notify(`Package "${name}" not found in catalog`, "error");
      return;
    }

    ctx.ui.setWorkingMessage?.(`Updating ${name}...`);
    let updateSucceeded = false;
    try {
      await piUpdate(entry.source);
      ctx.ui.notify(`Updated "${name}"`, "info");
      updateSucceeded = true;
    } catch {
      ctx.ui.notify(`Warning: update of "${name}" failed`, "warning");
    }
    ctx.ui.setWorkingMessage?.();

    // Install companions declared in the updated package manifest
    if (updateSucceeded) {
      await installCompanions(entry.source, ctx);
    }

    // Reload extensions so updated tools are available immediately
    if (updateSucceeded && typeof ctx.reload === "function") {
      ctx.ui.notify("Reloading extensions...", "info");
      try {
        await ctx.reload();
        ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
      } catch {
        try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
      }
    } else {
      ctx.ui.notify(
        "Package updated. Restart pi for changes to take effect.",
        "warning",
      );
    }

    // Check setup requirements after update
    const setup = checkSetupForSource(entry.source, ctx.home);
    if (setup && !setup.ok) {
      ctx.ui.notify(
        `Setup incomplete for "${name}": ${formatSetupStatus(setup)}`,
        "warning",
      );
    }
    return;
  }

  // --- Update all -----------------------------------------------------------
  const names = Object.keys(packages);
  if (names.length === 0) {
    ctx.ui.notify("Catalog is empty — nothing to update", "info");
    return;
  }

  let updated = 0;
  let failed = 0;
  const setupWarnings: string[] = [];

  for (const pkgName of names) {
    const entry = packages[pkgName];
    ctx.ui.setWorkingMessage?.(`Updating ${pkgName} (${updated + 1}/${names.length})...`);
    let updateSucceeded = false;
    try {
      await piUpdate(entry.source);
      updated++;
      updateSucceeded = true;
    } catch {
      ctx.ui.notify(`Warning: update of "${pkgName}" failed`, "warning");
      failed++;
    }

    // Install companions and check setup after successful update
    if (updateSucceeded) {
      await installCompanions(entry.source, ctx);
      const setup = checkSetupForSource(entry.source, ctx.home);
      if (setup && !setup.ok) {
        setupWarnings.push(`${pkgName}: ${formatSetupStatus(setup)}`);
      }
    }
  }
  ctx.ui.setWorkingMessage?.();

  const parts: string[] = [
    `Updated ${updated}/${names.length} packages${failed > 0 ? ` (${failed} failed)` : ""}`,
  ];
  if (setupWarnings.length > 0) {
    parts.push(`Setup incomplete:\n  ${setupWarnings.join("\n  ")}`);
  }

  ctx.ui.notify(
    parts.join("\n"),
    failed > 0 || setupWarnings.length > 0 ? "warning" : "info",
  );

  // Reload extensions so updated tools are available immediately
  if (updated > 0 && typeof ctx.reload === "function") {
    ctx.ui.notify("Reloading extensions...", "info");
    try {
      await ctx.reload();
      ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
    } catch {
      try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
    }
  } else if (updated > 0) {
    ctx.ui.notify(
      "Packages updated. Restart pi for changes to take effect.",
      "warning",
    );
  }
}
