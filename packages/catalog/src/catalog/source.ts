/**
 * Shared source-parsing logic for package source strings.
 *
 * Centralises npm-name extraction, git-name cleaning, and source-to-key
 * derivation so that `install.ts` and `reconcile.ts` don't duplicate the
 * same logic.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSource {
  /** Identity key for deduplication. */
  name: string;
  /** Source type. */
  type: "npm" | "git" | "local";
  /** For npm: the package name without the npm: prefix. */
  npmName?: string;
  /** For npm with optional version pin: the version after @, or undefined. */
  npmVersion?: string;
}

// ---------------------------------------------------------------------------
// npm helpers
// ---------------------------------------------------------------------------

/**
 * Extract the npm package name from "pkg@version" or "@scope/pkg@version".
 */
export function extractNpmName(spec: string): string {
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
 * Extract version from an npm spec (the part after the last relevant @).
 */
export function extractNpmVersion(spec: string): string | undefined {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? undefined : spec.slice(secondAt + 1);
  }
  const atIdx = spec.indexOf("@");
  return atIdx === -1 ? undefined : spec.slice(atIdx + 1);
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * Clean a git/URL source into a canonical host/path name.
 *
 * Examples:
 *   "github.com/user/repo@v1"         -> "github.com/user/repo"
 *   "git@github.com:user/repo"        -> "github.com/user/repo"
 *   "https://github.com/user/repo@v2" -> "github.com/user/repo"
 *   "ssh://git@github.com/user/repo"  -> "github.com/user/repo"
 */
export function cleanGitName(raw: string): string {
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
// Composite helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw source string into a structured form.
 */
export function parseSource(raw: string): ParsedSource {
  // npm:pkg@version or npm:pkg
  if (raw.startsWith("npm:")) {
    const rest = raw.slice(4);
    const npmName = extractNpmName(rest);
    const npmVersion = extractNpmVersion(rest);
    return { name: npmName, type: "npm", npmName, npmVersion };
  }

  // git: shorthand
  if (raw.startsWith("git:")) {
    const rest = raw.slice(4);
    const name = cleanGitName(rest);
    return { name, type: "git" };
  }

  // HTTPS / SSH protocol URLs treated as git sources
  if (
    raw.startsWith("https://") ||
    raw.startsWith("http://") ||
    raw.startsWith("ssh://") ||
    raw.startsWith("git://")
  ) {
    const name = cleanGitName(raw);
    return { name, type: "git" };
  }

  // Everything else is a local path — derive name from directory basename
  const name = path.basename(path.resolve(raw));
  return { name, type: "local" };
}

/**
 * Derive the installed-map key from a source string.
 *
 * - npm sources → npm package name (e.g. "@foo/bar")
 * - git sources → cleaned host/path (e.g. "github.com/user/repo")
 * - local paths → the raw source string itself
 */
export function sourceToKey(source: string): string {
  if (source.startsWith("npm:")) {
    return extractNpmName(source.slice(4));
  }
  if (source.startsWith("git:")) {
    return cleanGitName(source.slice(4));
  }
  if (
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://")
  ) {
    return cleanGitName(source);
  }
  // Local path — key is the raw source itself (matches scanInstalled behavior)
  return source;
}

/**
 * Extract a version string from a source for lock-file recording.
 *
 * Returns `"unknown"` when the source carries no version/ref information.
 */
export function extractVersionFromSource(source: string): string {
  if (source.startsWith("npm:")) {
    return extractNpmVersion(source.slice(4)) ?? "unknown";
  }
  if (source.startsWith("git:")) {
    const rest = source.slice(4);
    const atIdx = rest.lastIndexOf("@");
    return atIdx !== -1 ? rest.slice(atIdx + 1) : "unknown";
  }
  return "unknown";
}
