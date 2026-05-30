/**
 * Rate-limited update check cache stored in the lock file.
 *
 * The cache lives under the `_updateCache` key in catalog.lock.json.
 * Each checker has its own cache entry keyed by a cache key (e.g. "self-update").
 *
 * Rate limit: check no more than once per hour.
 */
import { readLock, writeLock } from "../config/io.js";
import type { UpdateCacheEntry } from "./types.js";

/** 1 hour in milliseconds. */
const RATE_LIMIT_MS = 60 * 60 * 1000;

/** The key used in the lock file for the update cache. */
const CACHE_KEY = "_updateCache";

/**
 * Read a cached update check result.
 *
 * Returns the cached entry if it exists and is less than 1 hour old,
 * or undefined if no valid cache exists.
 */
export function readUpdateCache(
  cacheKey: string,
  home?: string,
): UpdateCacheEntry | undefined {
  const lock = readLock(home) as Record<string, unknown>;
  const cache = lock[CACHE_KEY] as Record<string, UpdateCacheEntry> | undefined;
  if (!cache) return undefined;

  const entry = cache[cacheKey];
  if (!entry) return undefined;

  const age = Date.now() - new Date(entry.checkedAt).getTime();
  if (age >= RATE_LIMIT_MS) return undefined;

  return entry;
}

/**
 * Write a cached update check result to the lock file.
 */
export function writeUpdateCache(
  cacheKey: string,
  entry: UpdateCacheEntry,
  home?: string,
): void {
  const lock = readLock(home) as Record<string, unknown>;
  const cache = (lock[CACHE_KEY] ?? {}) as Record<string, UpdateCacheEntry>;
  cache[cacheKey] = entry;
  (lock as Record<string, unknown>)[CACHE_KEY] = cache;
  writeLock(lock as import("../config/schema.js").LockFile, home);
}
