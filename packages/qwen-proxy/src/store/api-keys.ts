import { timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/** Constant-time comparison of two strings. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Check if a key is valid: present in the non-revoked api_keys table OR in envKeys.
 * Env check is done first (O(n) constant-time) before the DB round-trip.
 */
export function isValidKey(
  db: Database.Database,
  key: string,
  envKeys: string[],
): boolean {
  // Check env keys first (parallel in-memory list, D8)
  for (const envKey of envKeys) {
    if (constantTimeEquals(key, envKey)) return true;
  }

  // Check table: non-revoked row
  const row = db
    .prepare("SELECT 1 FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(key);
  return row !== undefined;
}

/** Fire-and-forget touch of last_used_at for table keys. */
export function touchLastUsed(db: Database.Database, key: string): void {
  try {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE key = ?").run(
      Date.now(),
      key,
    );
  } catch {
    // fire-and-forget — never block on this
  }
}
