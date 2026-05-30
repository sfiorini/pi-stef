/**
 * `ct init` command implementation.
 *
 * Scans currently installed pi packages and generates `cat.yaml`.
 * With `--from-gist <id>`, imports catalog content from a public GitHub Gist.
 */

import yaml from "js-yaml";

import { scanInstalled } from "../catalog/install.js";
import { CatalogYamlSchema } from "../config/schema.js";
import type { CatalogYaml } from "../config/schema.js";
import type { CommandArgs, CommandCtx } from "./types.js";
import { writeCatalog } from "../config/io.js";
import { readGist } from "../sync/gist.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `initCommand`. Uses the base `CommandCtx`. */
export type InitContext = CommandCtx;

// ---------------------------------------------------------------------------
// initCommand
// ---------------------------------------------------------------------------

/**
 * Initialize a new catalog.
 *
 * - Without flags: scans installed packages and generates a catalog with
 *   `rating: 'core'` for every discovered package.
 * - With `--from-gist=<id>`: fetches the gist, reads its `cat.yaml` file,
 *   validates it, and writes it as the local catalog.
 */
export async function initCommand(
  args: CommandArgs,
  ctx: InitContext,
): Promise<void> {
  const { flags } = args;

  // --from-gist mode
  const gistId = typeof flags["from-gist"] === "string" ? flags["from-gist"] : undefined;

  if (gistId) {
    await initFromGist(gistId, ctx);
    return;
  }

  // Default: scan installed packages
  initFromScan(ctx);
}

// ---------------------------------------------------------------------------
// initFromScan
// ---------------------------------------------------------------------------

function initFromScan(ctx: InitContext): void {
  let installed: Record<string, { source: string }>;
  try {
    installed = scanInstalled(ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to scan installed packages: ${message}`, "error");
    return;
  }
  const names = Object.keys(installed);

  const packages: CatalogYaml["packages"] = {};
  for (const [name, pkg] of Object.entries(installed)) {
    packages[name] = {
      source: pkg.source,
      rating: "core",
    };
  }

  const catalog: CatalogYaml = {
    meta: { pi_version: "0.0.0" },
    packages,
  };

  writeCatalog(catalog, ctx.home);

  ctx.ui.notify(
    `Initialized catalog with ${names.length} package${names.length === 1 ? "" : "s"}.`,
    "info",
  );
}

// ---------------------------------------------------------------------------
// initFromGist
// ---------------------------------------------------------------------------

async function initFromGist(gistId: string, ctx: InitContext): Promise<void> {
  let gistContent: string;

  try {
    const gist = await readGist(gistId);
    const catFile = gist.files["cat.yaml"];

    if (!catFile?.content) {
      ctx.ui.notify(
        `Gist "${gistId}" does not contain a cat.yaml file.`,
        "error",
      );
      return;
    }

    gistContent = catFile.content;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to fetch gist: ${message}`, "error");
    return;
  }

  // Validate and write
  const parsed = yaml.load(gistContent);
  const catalog = CatalogYamlSchema.parse(parsed);

  writeCatalog(catalog, ctx.home);

  const count = Object.keys(catalog.packages).length;
  ctx.ui.notify(
    `Imported catalog from gist with ${count} package${count === 1 ? "" : "s"}.`,
    "info",
  );
}
