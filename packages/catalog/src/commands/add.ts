/**
 * `ct add` subcommand implementation.
 *
 * Adds a new package to the catalog. Supports:
 *   - Full args: `ct add <source> [--type <t>]`
 *   - Git source without `--type`: prompts for type via `ctx.ui.select()`
 *   - After adding, runs `pi install` to install the package
 *
 * Uses `addPackage` from `crud.ts` for validation and catalog mutation,
 * and `writeCatalog` / `readCatalog` for persistence.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { addPackage } from "../catalog/crud.js";
import { sourceToKey } from "../catalog/source.js";
import { checkSetupForSource, formatSetupStatus } from "../catalog/setup.js";
import { PI_STEF_PACKAGES } from "../catalog/packages.js";
import { readCatalog, writeCatalog } from "../config/io.js";
import { piInstall } from "../util/exec.js";
import { installCompanions } from "../catalog/companions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `addCommand`, extending the base with `select` for type prompts. */
export interface AddCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    select?: <T>(options: {
      message: string;
      choices: { value: T; label: string }[];
    }) => Promise<T>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveType(
  flags: Record<string, true | string>,
): "skill" | "pi-native" | undefined {
  const raw =
    "s" in flags
      ? flags["s"]
      : "type" in flags
        ? flags["type"]
        : undefined;

  if (raw === true || raw === undefined) return undefined;
  if (raw === "skill" || raw === "pi-native") return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// addCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct add` subcommand.
 *
 * New syntax (preferred): `ct add <source> [--type ...]`
 *   — name is auto-derived from source via `sourceToKey()`.
 *
 * Legacy syntax (deprecated): `ct add <name> <source> [--type ...]`
 *   — still accepted but emits a deprecation warning.
 *
 * Reads the catalog, validates inputs, prompts for type if needed,
 * adds the package, writes the catalog, and runs `pi install`.
 */
export async function addCommand(args: CommandArgs, ctx: AddCtx): Promise<void> {
  const { positional, flags } = args;

  // --- Handle --scope batch mode ---------------------------------------------
  if ("scope" in flags) {
    const scope = flags["scope"];
    if (scope !== "@pi-stef") {
      ctx.ui.notify(`Unsupported scope: "${scope}". Use --scope @pi-stef.`, "error");
      return;
    }

    const catalog = readCatalog(ctx.home);
    let added = 0;
    let skipped = 0;
    let currentCatalog = catalog;

    for (const pkg of PI_STEF_PACKAGES) {
      const npmSource = `npm:${pkg}`;

      // Skip if already in catalog
      if (currentCatalog.packages[pkg]) {
        skipped++;
        continue;
      }

      try {
        currentCatalog = addPackage(currentCatalog, pkg, npmSource);
        added++;
      } catch (err: unknown) {
        // Unexpected validation error — warn but continue
        ctx.ui.notify(
          `Warning: failed to add "${pkg}": ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
        skipped++;
      }
    }

    if (added > 0) {
      writeCatalog(currentCatalog, ctx.home);
    }

    // Install all added packages
    const setupWarnings: string[] = [];
    if (added > 0) {
      for (const pkg of PI_STEF_PACKAGES) {
        if (currentCatalog.packages[pkg]?.source === `npm:${pkg}`) {
          ctx.ui.setWorkingMessage?.(`Installing ${pkg}...`);
          try {
            await piInstall(`npm:${pkg}`);

            // Check setup after successful install
            const setup = checkSetupForSource(`npm:${pkg}`, ctx.home);
            if (setup && !setup.ok) {
              setupWarnings.push(`${pkg}: ${formatSetupStatus(setup)}`);
            }
          } catch {
            ctx.ui.notify(`Warning: install of "${pkg}" failed`, "warning");
          }
        }
      }
      ctx.ui.setWorkingMessage?.();
    }

    const parts: string[] = [
      `Scope @pi-stef: added ${added}, skipped ${skipped} (already in catalog)`,
    ];
    if (setupWarnings.length > 0) {
      parts.push(`Setup incomplete:\n  ${setupWarnings.join("\n  ")}`);
    }

    ctx.ui.notify(
      parts.join("\n"),
      setupWarnings.length > 0 ? "warning" : "info",
    );

    // Reload extensions so new packages are available immediately
    if (added > 0 && typeof ctx.reload === "function") {
      ctx.ui.notify("Reloading extensions...", "info");
      try {
        await ctx.reload();
        ctx.ui.notify("Extensions reloaded — new tools are available.", "info");
      } catch {
        try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
      }
    } else if (added > 0) {
      ctx.ui.notify(
        "Package installed. Restart pi for changes to take effect.",
        "warning",
      );
    }

    return;
  }

  // --- Handle legacy 2-arg syntax: ct add <name> <source> -------------------
  let name: string;
  let source: string;

  if (positional.length >= 2) {
    name = positional[0];
    source = positional[1];
    ctx.ui.notify(
      `"ct add <name> <source>" is legacy. Use "ct add <source>" — name is auto-derived.`,
      "warning",
    );
  } else if (positional.length === 1) {
    source = positional[0];
    name = sourceToKey(source);
  } else {
    ctx.ui.notify(
      "Usage: ct add <source> [--type <skill|pi-native>]",
      "error",
    );
    return;
  }

  let type = resolveType(flags);

  // --- Read catalog ---------------------------------------------------------
  const catalog = readCatalog(ctx.home);

  // --- Prompt for type when git source and no explicit type -----------------
  if (source.startsWith("git:") && type === undefined) {
    if (ctx.ui.select) {
      type = await ctx.ui.select<"skill" | "pi-native">({
        message: `Select type for "${name}"`,
        choices: [
          { value: "skill", label: "Skill" },
          { value: "pi-native", label: "Pi-native" },
        ],
      });
    }
  }

  // --- Add package ----------------------------------------------------------
  try {
    const updated = addPackage(catalog, name, source, type);
    writeCatalog(updated, ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
    return;
  }

  ctx.ui.notify(`Added "${name}" to catalog`, "info");

  // --- Run pi install -------------------------------------------------------
  ctx.ui.setWorkingMessage?.(`Installing ${name}...`);
  let installSucceeded = false;
  try {
    await piInstall(source);
    installSucceeded = true;
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" added to catalog but install failed`,
      "warning",
    );
  }
  ctx.ui.setWorkingMessage?.();

  // --- Install companions declared in the installed package manifest ----------
  if (installSucceeded) {
    await installCompanions(source, ctx);
  }

  // --- Reload extensions so the new package is available immediately ---------
  if (installSucceeded && typeof ctx.reload === "function") {
    ctx.ui.notify("Reloading extensions...", "info");
    try {
      await ctx.reload();
      ctx.ui.notify("Extensions reloaded — new tools are available.", "info");
    } catch {
      // ctx.ui may be invalid after reload; best-effort notify
      try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
    }
  } else {
    ctx.ui.notify(
      "Package installed. Restart pi for changes to take effect.",
      "warning",
    );
  }

  // --- Check setup requirements ---------------------------------------------
  const setup = checkSetupForSource(source, ctx.home);
  if (setup && !setup.ok) {
    ctx.ui.notify(
      `Setup incomplete for "${name}": ${formatSetupStatus(setup)}`,
      "warning",
    );
  }
}
