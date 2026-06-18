/**
 * Hardcoded list of @pi-stef packages for scope-based batch operations.
 *
 * Used by `ct add --scope @pi-stef` and `ct remove --scope @pi-stef`
 * to identify which packages belong to the @pi-stef ecosystem.
 *
 * NOTE: `@pi-stef/catalog` is intentionally excluded — it manages the
 * other packages and should not be batch-operated on itself.
 */

import { extractNpmName } from "./source.js";

/** The catalog package itself (excluded from batch operations). */
export const CATALOG_PACKAGE_NAME = "@pi-stef/catalog";

/**
 * All @pi-stef packages except the catalog itself.
 *
 * This list is used for `--scope @pi-stef` batch operations.
 */
export const PI_STEF_PACKAGES: readonly string[] = [
  "@pi-stef/agent-workflows",
  "@pi-stef/atlassian",
  "@pi-stef/figma",
  "@pi-stef/pair",
  "@pi-stef/paths",
  "@pi-stef/team",
  "@pi-stef/web",
] as const;

/**
 * Returns true if the given package name is a @pi-stef package
 * (excluding the catalog itself).
 */
export function isPiStefPackage(name: string): boolean {
  return PI_STEF_PACKAGES.includes(name);
}

/**
 * Returns true if the source string refers to a @pi-stef package.
 *
 * Handles both `npm:@scope/pkg@version` and bare package name formats.
 * Explicitly excludes `@pi-stef/catalog` — it manages the others
 * and should not be included in batch scope operations.
 */
export function isPiStefSource(source: string): boolean {
  // npm: prefixed source — extract the package name
  if (source.startsWith("npm:")) {
    const pkgName = extractNpmName(source.slice(4));
    // Never include the catalog package itself in batch operations
    if (pkgName === CATALOG_PACKAGE_NAME) return false;
    return PI_STEF_PACKAGES.includes(pkgName);
  }

  // Non-npm source — check if it's a bare package name
  return PI_STEF_PACKAGES.includes(source);
}
