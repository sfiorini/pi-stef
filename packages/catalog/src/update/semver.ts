/**
 * Simple semver comparison utilities.
 *
 * Compares version strings of the form "major.minor.patch" (with optional
 * pre-release tags). Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * **Note:** Pre-release tags (e.g. `-beta`, `-rc.1`) are stripped before
 * comparison, so `1.0.0-beta` compares equal to `1.0.0`. This is safe for
 * the npm `latest` dist-tag, which never returns pre-release versions, but
 * could misreport if a pre-release is ever returned.
 */

/**
 * Compare two semver-like version strings.
 * Pre-release tags are stripped (e.g. "1.0.0-beta" → "1.0.0").
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/-.*/, "").split(".").map(Number);
  const partsB = b.replace(/-.*/, "").split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const valA = partsA[i] ?? 0;
    const valB = partsB[i] ?? 0;
    if (valA < valB) return -1;
    if (valA > valB) return 1;
  }

  // Versions are equal (ignoring pre-release)
  return 0;
}

/**
 * Returns true if `latest` is strictly greater than `current`.
 */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
