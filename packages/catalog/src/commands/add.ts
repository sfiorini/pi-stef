/**
 * `ct add` subcommand implementation.
 *
 * Adds a new package to the catalog. Supports:
 *   - Full args: `ct add <name> <source> [--rating <r>] [--type <t>]`
 *   - Git source without `--type`: prompts for type via `ctx.ui.select()`
 *   - After adding, runs `pi install` to install the package
 *
 * Uses `addPackage` from `crud.ts` for validation and catalog mutation,
 * and `writeCatalog` / `readCatalog` for persistence.
 */

import type { CatalogYaml } from "../config/schema.js";
import type { RatingValue } from "../catalog/ratings.js";
import { addPackage } from "../catalog/crud.js";
import { readCatalog, writeCatalog } from "../config/io.js";
import { piInstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Arguments parsed from the command line by the dispatcher. */
export interface AddArgs {
  /** Positional arguments: [name, source] */
  positional: string[];
  /** Parsed flags. */
  flags: Record<string, true | string>;
}

/** Context provided by the pi extension runtime. */
export interface AddCtx {
  ui: {
    notify: (msg: string, type?: "error" | "info" | "warning") => void;
    select?: <T>(options: {
      message: string;
      choices: { value: T; label: string }[];
    }) => Promise<T>;
  };
  /** Home directory override (for testing). */
  home?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_RATINGS: RatingValue[] = ["core", "useful", "debatable"];

function isValidRating(value: string): value is RatingValue {
  return VALID_RATINGS.includes(value as RatingValue);
}

function resolveRating(flags: Record<string, true | string>): RatingValue {
  const raw =
    "r" in flags
      ? flags["r"]
      : "rating" in flags
        ? flags["rating"]
        : undefined;

  if (raw === true || raw === undefined) return "core";
  if (typeof raw === "string" && isValidRating(raw)) return raw;
  return "core";
}

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
 * Reads the catalog, validates inputs, prompts for type if needed,
 * adds the package, writes the catalog, and runs `pi install`.
 */
export async function addCommand(args: AddArgs, ctx: AddCtx): Promise<void> {
  const { positional, flags } = args;
  const name = positional[0];
  const source = positional[1];

  // --- Validate required args -----------------------------------------------
  if (!name || !source) {
    ctx.ui.notify(
      "Usage: ct add <name> <source> [--rating <core|useful|debatable>] [--type <skill|pi-native>]",
      "error",
    );
    return;
  }

  const rating = resolveRating(flags);
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
    const updated = addPackage(catalog, name, source, rating, type);
    writeCatalog(updated, ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
    return;
  }

  ctx.ui.notify(`Added "${name}" to catalog`, "info");

  // --- Run pi install -------------------------------------------------------
  try {
    await piInstall(source);
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" added to catalog but install failed`,
      "warning",
    );
  }
}
