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
// Source parsing helpers
// ---------------------------------------------------------------------------

interface ParsedSource {
  /** Identity key for deduplication. */
  name: string;
  /** Source type. */
  type: "npm" | "git" | "local";
  /** For npm: the package name without the npm: prefix. */
  npmName?: string;
  /** For npm with optional version pin: the version after @, or undefined. */
  npmVersion?: string;
}

/**
 * Parse a raw source string into a structured form.
 */
function parseSource(raw: string): ParsedSource {
  // npm:pkg@version or npm:pkg
  if (raw.startsWith("npm:")) {
    const rest = raw.slice(4); // "@foo/bar@1.2.3" or "my-pkg"
    const npmName = extractNpmName(rest);
    return { name: npmName, type: "npm", npmName };
  }

  // git: shorthand
  if (raw.startsWith("git:")) {
    const rest = raw.slice(4); // "github.com/user/repo@v1" or "git@github.com:user/repo@v1"
    const name = extractGitName(rest);
    return { name, type: "git" };
  }

  // HTTPS / SSH protocol URLs treated as git sources
  if (
    raw.startsWith("https://") ||
    raw.startsWith("http://") ||
    raw.startsWith("ssh://") ||
    raw.startsWith("git://")
  ) {
    const name = extractGitName(raw);
    return { name, type: "git" };
  }

  // Everything else is a local path — derive name from directory basename
  const name = path.basename(path.resolve(raw));
  return { name, type: "local" };
}

/**
 * Extract the npm package name from "pkg@version" or "@scope/pkg@version".
 */
function extractNpmName(spec: string): string {
  // Scoped package: @scope/pkg@version -> @scope/pkg
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? spec : spec.slice(0, secondAt);
  }
  // Unscoped: pkg@version -> pkg
  const atIdx = spec.indexOf("@");
  return atIdx === -1 ? spec : spec.slice(0, atIdx);
}

/**
 * Extract a human-readable name from a git/URL source.
 *
 * Examples:
 *   "github.com/user/repo@v1"   -> "github.com/user/repo"
 *   "git@github.com:user/repo"  -> "github.com/user/repo"
 *   "https://github.com/user/repo@v2" -> "github.com/user/repo"
 *   "ssh://git@github.com/user/repo@v1" -> "github.com/user/repo"
 */
function extractGitName(raw: string): string {
  let cleaned = raw;

  // Strip protocol prefix
  cleaned = cleaned.replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)/, "");
  // Strip user@ prefix (e.g. git@)
  cleaned = cleaned.replace(/^[^@/]+@/, "");
  // Convert colon to slash for git@host:path style
  cleaned = cleaned.replace(/:/, "/");

  // Strip trailing @ref
  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx !== -1) {
    cleaned = cleaned.slice(0, atIdx);
  }

  // Strip trailing .git
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }

  return cleaned;
}

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
    home,
    ".pi",
    "agent",
    "npm",
    "node_modules",
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
