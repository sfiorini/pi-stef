/**
 * `ct reset` subcommand implementation.
 *
 * Full nuke: uninstalls all @pi-stef packages, deletes gist refs,
 * deletes config files (cat.yaml, catalog.lock.json, .gist),
 * and removes the empty catalog directory.
 *
 * Usage:
 *   - `ct reset` — prompts for confirmation
 *   - `ct reset --yes` — skips confirmation
 *
 * This is a destructive operation. The catalog can be re-initialized
 * with `ct init` after resetting.
 */

import fs from "node:fs";
import type { CommandArgs, CommandCtx } from "./types.js";
import { reloadNotice } from "./types.js";
import { isPiStefSource } from "../catalog/packages.js";
import { catalogDir, catalogFile, lockFile } from "../config/paths.js";
import { piUninstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `resetCommand`, extending the base with `confirm`. */
export interface ResetCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// resetCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct reset` subcommand.
 *
 * 1. Check cat.yaml exists
 * 2. Confirm (skippable with --yes)
 * 3. Find @pi-stef packages (isPiStefSource excludes catalog)
 * 4. pi uninstall each
 * 5. Delete config files with fs.rmSync({ recursive: true, force: true })
 * 6. Remove empty catalog directory
 */
export async function resetCommand(
  args: CommandArgs,
  ctx: ResetCtx,
): Promise<void> {
  const { flags } = args;

  // --- Check cat.yaml exists ------------------------------------------------
  const catPath = catalogFile(ctx.home);
  if (!fs.existsSync(catPath)) {
    ctx.ui.notify("No catalog found. Run `ct init` first.", "error");
    return;
  }

  // --- Confirmation ----------------------------------------------------------
  const skipConfirm = "yes" in flags || "y" in flags;
  if (!skipConfirm && ctx.ui.confirm) {
    const confirmed = await ctx.ui.confirm(
      "Reset catalog?",
      "This uninstalls all @pi-stef packages and deletes all catalog config. Rebuild with ct init.",
    );
    if (!confirmed) {
      ctx.ui.notify("Reset cancelled", "info");
      return;
    }
  }

  // --- Find @pi-stef packages -----------------------------------------------
  // Read catalog directly (raw YAML) to avoid schema validation on corrupt files
  let packages: Record<string, { source: string }> = {};
  try {
    const yaml = await import("js-yaml");
    const content = fs.readFileSync(catPath, "utf8");
    const parsed = yaml.load(content) as { packages?: Record<string, { source: string }> };
    packages = parsed?.packages ?? {};
  } catch {
    // If YAML is corrupt, we still want to delete config files
    ctx.ui.notify("Warning: could not parse cat.yaml — skipping uninstall step", "warning");
  }

  const piStefNames = Object.keys(packages).filter(
    (name) => isPiStefSource(packages[name].source),
  );

  // --- Uninstall @pi-stef packages ------------------------------------------
  let uninstalled = 0;
  let failed = 0;

  for (const name of piStefNames) {
    ctx.ui.setWorkingMessage?.(`Uninstalling ${name} (${uninstalled + 1}/${piStefNames.length})...`);
    try {
      await piUninstall(packages[name].source);
      uninstalled++;
    } catch {
      ctx.ui.notify(`Warning: uninstall of "${name}" failed`, "warning");
      failed++;
    }
  }
  ctx.ui.setWorkingMessage?.();

  // --- Delete config files --------------------------------------------------
  const dir = catalogDir(ctx.home);
  const gistPath = `${dir}/.gist`;

  // Delete individual files first, then the directory
  for (const filePath of [catPath, lockFile(ctx.home), gistPath]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore errors — file may not exist
    }
  }

  // Remove the catalog directory itself
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore errors — directory may not exist or be non-empty
  }

  // --- Report ----------------------------------------------------------------
  const parts: string[] = [];
  if (piStefNames.length > 0) {
    parts.push(`uninstalled ${uninstalled}/${piStefNames.length} packages`);
  }
  parts.push("deleted config files");

  ctx.ui.notify(
    `Reset complete: ${parts.join(", ")}${failed > 0 ? ` (${failed} uninstall failed)` : ""}`,
    failed > 0 ? "warning" : "info",
  );

  // Reload so uninstalled packages' tools/skills are removed immediately
  if (typeof ctx.reload === "function") {
    try {
      await ctx.reload();
      ctx.ui.notify(reloadNotice(ctx, "Extensions reloaded."), "info");
    } catch {
      try { ctx.ui.notify("Extension reload failed — restart pi to pick up changes.", "warning"); } catch { /* runner invalidated */ }
    }
  }
}
