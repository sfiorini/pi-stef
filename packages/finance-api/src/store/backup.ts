import type Database from "better-sqlite3";

/**
 * Creates a byte-identical, openable copy of the SQLite database using better-sqlite3's online backup API.
 * Safe to call while the database is in use (WAL mode).
 */
export async function backupDb(db: Database.Database, destPath: string): Promise<void> {
  await db.backup(destPath);
}

/**
 * Returns a serializable snapshot of all tables for the /v1/export route.
 */
export function exportJson(db: Database.Database): Record<string, unknown[]> {
  const tables = ["accounts", "holdings", "transactions", "prices", "lots", "goals", "suggestion_records", "market_sessions"];
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    try {
      result[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      // Table might not exist yet
      result[table] = [];
    }
  }
  return result;
}
