/**
 * Shared types for update checking.
 */

/** Result of an update check. */
export interface UpdateCheckResult {
  /** The currently installed version. */
  current: string;
  /** The latest version available on the registry (undefined on network error). */
  latest: string | undefined;
  /** Whether an update is available. */
  updateAvailable: boolean;
}

/** Cache entry stored in the lock file under _updateCache. */
export interface UpdateCacheEntry {
  /** The latest version found at check time. */
  latest: string;
  /** ISO-8601 timestamp of when the check was performed. */
  checkedAt: string;
}
