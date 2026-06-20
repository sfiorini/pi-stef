import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { catalogDir } from "../config/paths";
import type { CatalogYaml } from "../config/schema";

/**
 * Lightweight tombstone log for packages explicitly removed via ct remove.
 *
 * Problem: ct remove deletes the package from the local cat.yaml. The next
 * ct sync pulls the remote catalog (which still has the package) and the
 * reconcile step has no way to know the local deletion was intentional vs.
 * a package the user never had. The result: the removed package gets
 * re-installed.
 *
 * Solution: ct remove writes a tombstone record. ct sync applies tombstones
 * (drops matching packages from the merged catalog) and clears them — they
 * have served their purpose. The next push propagates the removal upstream.
 */

const TOMBSTONE_FILE = "removed.json";

function tombstonePath(home?: string): string {
  return path.join(catalogDir(home), TOMBSTONE_FILE);
}

/** Write a tombstone for a removed package name. Idempotent (no duplicates). */
export function recordRemoval(name: string, home?: string): void {
  const existing = readTombstones(home);
  if (existing.includes(name)) return;
  existing.push(name);
  const dir = path.dirname(tombstonePath(home));
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${TOMBSTONE_FILE}.tmp`);
  // Atomic rename to avoid torn writes from concurrent removes.
  writeFileSync(tmp, JSON.stringify(existing), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, tombstonePath(home));
}

/** Read all tombstone records. Deduplicated via Set. */
export function readTombstones(home?: string): string[] {
  const p = tombstonePath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...new Set(parsed)];
  } catch {
    // Corrupt file — delete it so we don't silently stall forever.
    try { unlinkSync(p); } catch { /* best effort */ }
  }
  return [];
}

/** Apply tombstones to a catalog, then clear the log. */
export function applyRemovalTombstones(
  catalog: CatalogYaml,
  home?: string,
): CatalogYaml {
  const removed = new Set(readTombstones(home));
  for (const key of removed) {
    delete catalog.packages[key];
  }
  // Tombsones have served their purpose — the packages are now dropped
  // from the in-memory catalog and won't be re-installed. Clear them
  // regardless of whether the subsequent push succeeds, so they don't
  // leak into the next sync cycle and silently drop re-added packages.
  try {
    const p = tombstonePath(home);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best effort
  }
  return catalog;
}

/** Clear the tombstone log without applying (used by standalone ct push). */
export function clearTombstones(home?: string): void {
  const p = tombstonePath(home);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best effort
  }
}
