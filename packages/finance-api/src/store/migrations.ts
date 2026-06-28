import type Database from "better-sqlite3";
import { MIGRATIONS_V1, type Migration } from "./schema";

export function applyMigrations(db: Database.Database, all: Migration[] = MIGRATIONS_V1): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_versions").all() as { version: number }[]).map((r) => r.version),
  );
  const apply = db.transaction((toApply: Migration[]) => {
    for (const m of toApply) {
      db.exec(m.statement);
      db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
    }
  });
  const pending = all.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  apply(pending);
}
