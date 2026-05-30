/**
 * Self-update checker for @pi-stef/catalog.
 *
 * Checks npm registry for the latest version of @pi-stef/catalog,
 * compares with the current version, and reports availability.
 * Does NOT auto-install. Rate-limited to once per hour via lock file cache.
 */
import { fetchLatestVersion } from "./registry.js";
import { readUpdateCache, writeUpdateCache } from "./update-cache.js";
import { isNewer } from "./semver.js";
import type { UpdateCheckResult } from "./types.js";

/** Cache key used in the lock file. */
const CACHE_KEY = "self-update";

/**
 * Check whether a newer version of @pi-stef/catalog is available.
 *
 * @param currentVersion - The currently installed version string.
 * @param home - Optional home directory override (for testing).
 * @returns Update check result with current, latest, and updateAvailable.
 */
export async function checkSelfUpdate(
  currentVersion: string,
  home?: string,
): Promise<UpdateCheckResult> {
  // Check rate-limited cache first
  const cached = readUpdateCache(CACHE_KEY, home);
  if (cached) {
    return {
      current: currentVersion,
      latest: cached.latest,
      updateAvailable: isNewer(cached.latest, currentVersion),
    };
  }

  // Fetch latest version from npm registry
  const latest = await fetchLatestVersion("@pi-stef/catalog");

  if (latest === undefined) {
    // Network error — skip silently
    return {
      current: currentVersion,
      latest: undefined,
      updateAvailable: false,
    };
  }

  // Cache the result
  writeUpdateCache(CACHE_KEY, {
    latest,
    checkedAt: new Date().toISOString(),
  }, home);

  return {
    current: currentVersion,
    latest,
    updateAvailable: isNewer(latest, currentVersion),
  };
}
