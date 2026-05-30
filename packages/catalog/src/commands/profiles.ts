/**
 * `ct profiles` and `ct profile` subcommand implementations.
 *
 * `ct profiles` lists all profiles with an active indicator.
 * `ct profile <name>` switches the active profile.
 * `ct profile <name> --create` creates a new empty profile.
 * `ct profile <name> --delete` deletes a profile (with confirmation).
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog, writeCatalog } from "../config/io.js";
import {
  createProfile,
  switchProfile,
  deleteProfile,
  DEFAULT_PROFILE,
} from "../profiles/manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for profile commands. Extends base with `confirm` for deletion. */
export interface ProfilesCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    confirm?: (message: string) => Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// profilesCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct profiles` subcommand.
 *
 * Lists all available profiles, marking the active one with `*`.
 * The default profile is always listed.
 */
export async function profilesCommand(
  _args: CommandArgs,
  ctx: ProfilesCtx,
): Promise<void> {
  const catalog = readCatalog(ctx.home);
  const active = catalog.meta.activeProfile ?? DEFAULT_PROFILE;
  const profileNames = Object.keys(catalog.profiles ?? {});

  const lines: string[] = ["Profiles:"];

  // Default profile is always available
  const defaultMarker = active === DEFAULT_PROFILE ? " *" : "";
  lines.push(`  ${DEFAULT_PROFILE}${defaultMarker}`);

  // Named profiles
  for (const name of profileNames.sort()) {
    const marker = active === name ? " *" : "";
    lines.push(`  ${name}${marker}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// profileCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct profile` subcommand.
 *
 * Modes:
 *   - No positional args: show current profile
 *   - `ct profile <name>`: switch to the named profile
 *   - `ct profile <name> --create`: create a new profile
 *   - `ct profile <name> --delete`: delete a profile (prompts for confirmation)
 */
export async function profileCommand(
  args: CommandArgs,
  ctx: ProfilesCtx,
): Promise<void> {
  const { positional, flags } = args;
  const name = positional[0];

  // --- Show current profile ---
  if (!name) {
    const catalog = readCatalog(ctx.home);
    const active = catalog.meta.activeProfile ?? DEFAULT_PROFILE;
    ctx.ui.notify(`Current profile: ${active}`, "info");
    return;
  }

  const catalog = readCatalog(ctx.home);

  // --- Create mode ---
  if (flags["create"]) {
    try {
      const updated = createProfile(catalog, name);
      writeCatalog(updated, ctx.home);
      ctx.ui.notify(`Created profile "${name}"`, "info");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(message, "error");
    }
    return;
  }

  // --- Delete mode ---
  if (flags["delete"]) {
    try {
      // Pre-validate to catch errors before prompting
      if (name === DEFAULT_PROFILE) {
        throw new Error(`Cannot delete the "${DEFAULT_PROFILE}" profile`);
      }
      if (!catalog.profiles?.[name]) {
        throw new Error(`Profile "${name}" not found`);
      }

      // Confirm deletion
      if (ctx.ui.confirm) {
        const confirmed = await ctx.ui.confirm(
          `Delete profile "${name}"? This cannot be undone.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      const updated = deleteProfile(catalog, name);
      writeCatalog(updated, ctx.home);
      ctx.ui.notify(`Deleted profile "${name}"`, "info");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(message, "error");
    }
    return;
  }

  // --- Switch mode ---
  try {
    const updated = switchProfile(catalog, name);
    writeCatalog(updated, ctx.home);
    ctx.ui.notify(`Switched to profile "${name}"`, "info");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
  }
}
