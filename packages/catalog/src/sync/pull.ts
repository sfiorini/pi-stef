import yaml from "js-yaml";

import { CatalogYamlSchema, LockFileSchema } from "../config/schema.js";
import type { CatalogYaml, LockFile } from "../config/schema.js";
import { readGist, findGistByDescription } from "./gist.js";
import { readCachedGistId, writeCachedGistId } from "./cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a pull operation. */
export interface PullResult {
  catalog: CatalogYaml;
  lock: LockFile;
}

// ---------------------------------------------------------------------------
// pullCatalog
// ---------------------------------------------------------------------------

/**
 * Fetch a catalog and lock file from a GitHub Gist and deserialize them.
 *
 * Strategy:
 *  1. Check for a cached gist ID in `~/.pi/sf/catalog/.gist`.
 *  2. If no cached ID, search for an existing gist by description.
 *  3. Fetch the gist and read its files.
 *  4. Deserialize `cat.yaml` → CatalogYaml and `catalog.lock.json` → LockFile.
 *  5. Cache the discovered gist ID for future pulls.
 *
 * Throws if no gist is found for the given profile.
 */
export async function pullCatalog(
  profile: string,
  home?: string,
): Promise<PullResult> {
  const description = `catalog-${profile}`;

  // 1. Check for cached gist ID
  let gistId = readCachedGistId(home);
  let discovered = false;

  // 2. If no cached ID, find existing gist by description
  if (!gistId) {
    const existing = await findGistByDescription(description);
    if (existing) {
      gistId = existing.id;
      discovered = true;
    }
  }

  if (!gistId) {
    throw new Error(`No gist found for profile "${profile}" (description: "${description}")`);
  }

  // 3. Fetch gist files
  const gist = await readGist(gistId);

  // 4. Deserialize
  const catYamlContent = gist.files["cat.yaml"]?.content ?? "";
  const lockJsonContent = gist.files["catalog.lock.json"]?.content ?? "";

  const parsedYaml = yaml.load(catYamlContent);
  const catalog: CatalogYaml = CatalogYamlSchema.parse(parsedYaml);

  const parsedLock = JSON.parse(lockJsonContent);
  const lock: LockFile = LockFileSchema.parse(parsedLock);

  // 5. Cache the discovered gist ID for future pulls
  if (discovered) {
    writeCachedGistId(gistId, home);
  }

  return { catalog, lock };
}
