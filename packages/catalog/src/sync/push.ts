import yaml from "js-yaml";

import type { CatalogYaml, LockFile } from "../config/schema.js";
import {
  createGist,
  updateGist,
  findGistByDescription,
} from "./gist.js";
import { readCachedGistId, writeCachedGistId } from "./cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a push operation. */
export interface PushResult {
  gistId: string;
  gistUrl: string;
}

// ---------------------------------------------------------------------------
// pushCatalog
// ---------------------------------------------------------------------------

/**
 * Serialize a catalog and lock file, then push them to a GitHub Gist.
 *
 * Strategy:
 *  1. Check for a cached gist ID in `~/.pi/sf/catalog/.gist`.
 *  2. If no cached ID, search for an existing gist by description.
 *  3. If found, update the gist; otherwise create a new one.
 *  4. Cache the gist ID for future lookups.
 *
 * The gist description format is `catalog-<profile>`.
 * The gist contains two files: `cat.yaml` and `catalog.lock.json`.
 */
export async function pushCatalog(
  catalog: CatalogYaml,
  lock: LockFile,
  profile: string,
  home?: string,
): Promise<PushResult> {
  const description = `catalog-${profile}`;

  const files: Record<string, string> = {
    "cat.yaml": yaml.dump(catalog),
    "catalog.lock.json": JSON.stringify(lock, null, 2),
  };

  // 1. Check for cached gist ID
  let gistId = readCachedGistId(home);

  // 2. If no cached ID, find existing gist by description
  if (!gistId) {
    const existing = await findGistByDescription(description);
    if (existing) {
      gistId = existing.id;
    }
  }

  let result;

  if (gistId) {
    // 3a. Update existing gist
    result = await updateGist(gistId, files);
  } else {
    // 3b. Create new gist
    result = await createGist(files, description);
  }

  // 4. Cache the gist ID
  writeCachedGistId(result.id, home);

  return {
    gistId: result.id,
    gistUrl: result.url ?? `https://gist.github.com/${result.id}`,
  };
}
