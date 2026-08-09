import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations } from "./migrations";

export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; some filesystems don't support chmod
    }
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}
