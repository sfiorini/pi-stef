/**
 * Scanning installed pi packages from settings.json.
 *
 * S-302: scanInstalled reads ~/.pi/agent/settings.json and optionally
 * <cwd>/.pi/settings.json (project variant), parses the `packages`
 * array from each, and returns a merged map keyed by package name
 * with source, name, and version info. Project settings take
 * precedence over global for the same package key.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { parseSource } from "./source.js";
import { npmNodeModulesDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstalledPackage {
  /** The raw source string as it appears in settings.json. */
  source: string;
  /**
   * Human-readable / identity name derived from the source.
   * For npm: the npm package name (e.g. "@foo/bar").
   * For git: host/path (e.g. "github.com/user/repo").
   * For local: directory basename or the path itself.
   */
  name: string;
  /** Installed version if discoverable, otherwise undefined. */
  version: string | undefined;
}

export type InstalledMap = Record<string, InstalledPackage>;

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to read the version from an installed npm package's package.json.
 * Returns undefined if the file doesn't exist or can't be read.
 */
function readNpmVersion(
  home: string,
  npmName: string,
): string | undefined {
  const pkgJsonPath = path.join(
    npmNodeModulesDir(home),
    npmName,
    "package.json",
  );
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attempt to read the version from a local path package's package.json.
 * Returns undefined if the file doesn't exist or can't be read.
 */
function readLocalVersion(home: string, localPath: string): string | undefined {
  // Resolve relative paths against home (settings dir)
  const settingsDir = path.join(home, ".pi", "agent");
  const resolved = path.resolve(settingsDir, localPath);
  const pkgJsonPath = path.join(resolved, "package.json");
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// scanInstalled
// ---------------------------------------------------------------------------

/**
 * Read packages from a settings.json file and return a map of installed packages.
 * Returns empty map if the file doesn't exist or is malformed.
 */
function readPackagesFromSettings(
  settingsPath: string,
  home: string,
): InstalledMap {
  let settingsJson: string;
  try {
    settingsJson = fs.readFileSync(settingsPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return {};
  }

  const packages = settings.packages;
  if (!Array.isArray(packages)) {
    return {};
  }

  const result: InstalledMap = {};

  for (const entry of packages) {
    let rawSource: string;
    if (typeof entry === "string") {
      rawSource = entry;
    } else if (
      entry != null &&
      typeof entry === "object" &&
      "source" in entry &&
      typeof (entry as { source: unknown }).source === "string"
    ) {
      rawSource = (entry as { source: string }).source;
    } else {
      continue;
    }

    const parsed = parseSource(rawSource);

    let version: string | undefined;
    if (parsed.type === "npm") {
      version = readNpmVersion(home, parsed.npmName!);
    } else if (parsed.type === "local") {
      version = readLocalVersion(home, rawSource);
    }

    const key = parsed.type === "local" ? rawSource : parsed.name;

    result[key] = {
      source: rawSource,
      name: parsed.name,
      version,
    };
  }

  return result;
}

/**
 * Discover currently installed pi packages by reading
 * `~/.pi/agent/settings.json` and optionally
 * `<cwd>/.pi/settings.json`.
 *
 * When `cwd` is provided, project settings are merged on top of
 * global settings — project packages take precedence for the same key.
 *
 * Returns a map keyed by package identity name, each entry containing
 * the raw source, derived name, and version (if discoverable).
 */
export function scanInstalled(home?: string, cwd?: string): InstalledMap {
  const resolvedHome = home ?? os.homedir();
  const globalPath = path.join(resolvedHome, ".pi", "agent", "settings.json");

  const result = readPackagesFromSettings(globalPath, resolvedHome);

  if (cwd) {
    const projectPath = path.join(cwd, ".pi", "settings.json");
    const projectPackages = readPackagesFromSettings(projectPath, resolvedHome);
    // Project packages override global for the same key
    Object.assign(result, projectPackages);
  }

  return result;
}
