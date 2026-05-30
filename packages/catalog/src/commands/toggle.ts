/**
 * `ct toggle`, `ct enable`, and `ct disable` subcommand implementations.
 *
 * - `ct toggle <name>` cycles a package's rating through the cycle:
 *   core → useful → debatable → disabled → core
 * - `ct enable <name>` sets a disabled package back to its previous rating
 *   (or "core" if no previous rating stored). No-op when already enabled.
 * - `ct disable <name>` sets rating to disabled, saves the previous rating,
 *   and runs `pi uninstall` to remove the package.
 *
 * All commands read/write `cat.yaml` via `readCatalog` / `writeCatalog`
 * and provide user feedback through `ctx.ui.notify`.
 */

import { togglePackage, enablePackage, disablePackage } from "../catalog/crud.js";
import { readCatalog, writeCatalog } from "../config/io.js";
import { piUninstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Arguments parsed from the command line by the dispatcher. */
export interface ToggleArgs {
  /** Positional arguments: [name] */
  positional: string[];
  /** Parsed flags. */
  flags: Record<string, true | string>;
}

/** Context provided by the pi extension runtime. */
export interface ToggleCtx {
  ui: {
    notify: (msg: string, type?: "error" | "info" | "warning") => void;
  };
  /** Home directory override (for testing). */
  home?: string;
}

// ---------------------------------------------------------------------------
// toggleCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct toggle` subcommand.
 *
 * Cycles the package's rating through: core → useful → debatable → disabled → core.
 */
export async function toggleCommand(
  args: ToggleArgs,
  ctx: ToggleCtx,
): Promise<void> {
  const name = args.positional[0];

  if (!name) {
    ctx.ui.notify("Usage: ct toggle <name>", "error");
    return;
  }

  const catalog = readCatalog(ctx.home);

  try {
    const updated = togglePackage(catalog, name);
    writeCatalog(updated, ctx.home);
    ctx.ui.notify(
      `Toggled "${name}" to ${updated.packages[name].rating}`,
      "info",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
  }
}

// ---------------------------------------------------------------------------
// enableCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct enable` subcommand.
 *
 * Restores a disabled package to its previous rating (or "core").
 * No-op when the package is already enabled.
 */
export async function enableCommand(
  args: ToggleArgs,
  ctx: ToggleCtx,
): Promise<void> {
  const name = args.positional[0];

  if (!name) {
    ctx.ui.notify("Usage: ct enable <name>", "error");
    return;
  }

  const catalog = readCatalog(ctx.home);

  try {
    const updated = enablePackage(catalog, name);

    // enablePackage returns the same catalog reference when it's a no-op
    if (updated === catalog) {
      ctx.ui.notify(`"${name}" is already enabled`, "info");
      return;
    }

    writeCatalog(updated, ctx.home);
    ctx.ui.notify(
      `Enabled "${name}" (rating: ${updated.packages[name].rating})`,
      "info",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
  }
}

// ---------------------------------------------------------------------------
// disableCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct disable` subcommand.
 *
 * Sets the package rating to "disabled", saves the previous rating for later
 * restoration, and runs `pi uninstall` to remove the package.
 */
export async function disableCommand(
  args: ToggleArgs,
  ctx: ToggleCtx,
): Promise<void> {
  const name = args.positional[0];

  if (!name) {
    ctx.ui.notify("Usage: ct disable <name>", "error");
    return;
  }

  const catalog = readCatalog(ctx.home);

  try {
    const updated = disablePackage(catalog, name);
    writeCatalog(updated, ctx.home);
    ctx.ui.notify(`Disabled "${name}"`, "info");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
    return;
  }

  // Run pi uninstall after disabling
  try {
    await piUninstall(name);
  } catch {
    ctx.ui.notify(
      `Warning: "${name}" disabled in catalog but uninstall failed`,
      "warning",
    );
  }
}
