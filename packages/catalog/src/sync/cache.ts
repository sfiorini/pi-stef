import fs from "node:fs";
import path from "node:path";

import { catalogDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Gist ID cache
// ---------------------------------------------------------------------------

/**
 * Path to the `.gist` file that caches the gist ID for a profile.
 * Located inside `~/.pi/sf/catalog/.gist`.
 */
export function gistCachePath(home?: string): string {
  return path.join(catalogDir(home), ".gist");
}

/** Read the cached gist ID, or `undefined` if not cached. */
export function readCachedGistId(home?: string): string | undefined {
  const cacheFile = gistCachePath(home);
  try {
    if (fs.existsSync(cacheFile)) {
      const id = fs.readFileSync(cacheFile, "utf-8").trim();
      return id.length > 0 ? id : undefined;
    }
  } catch {
    // ignore read errors
  }
  return undefined;
}

/** Persist the gist ID to the cache file. */
export function writeCachedGistId(gistId: string, home?: string): void {
  const cacheFile = gistCachePath(home);
  const dir = path.dirname(cacheFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cacheFile, gistId, "utf-8");
}
