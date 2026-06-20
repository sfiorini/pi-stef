/**
 * Companion-package resolution for the catalog.
 *
 * A package may declare required companion sources in its own
 * `package.json` under `pi.companions` (a string array of npm:/git: sources).
 * When the catalog installs such a package it also installs each companion
 * that is not already installed.
 */

/** A parsed package.json-shaped object (only the fields we read). */
export interface PackageManifest {
  name?: string;
  pi?: {
    companions?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Extract the list of companion source strings from a package manifest.
 * Returns an empty array when none are declared or the shape is invalid.
 * Non-string and empty entries are filtered out (defensive).
 */
export function readCompanionsFromManifest(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const pi = (manifest as PackageManifest).pi;
  if (!pi || typeof pi !== "object") return [];
  const raw = (pi as { companions?: unknown }).companions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && c.length > 0);
}

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the companion sources declared by an installed package that are
 * not already installed. Pure function of the installed directory.
 *
 * @param installedDir Absolute path to the installed package directory
 *   (the dir containing its package.json).
 * @param alreadyInstalled Sources already installed (excluded).
 * @returns De-duplicated, ordered list of companion source strings to install.
 */
export function resolveCompanions(
  installedDir: string,
  alreadyInstalled: ReadonlySet<string>,
): string[] {
  const manifestPath = join(installedDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const all = readCompanionsFromManifest(manifest);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of all) {
    if (alreadyInstalled.has(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
