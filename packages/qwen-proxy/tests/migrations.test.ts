import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/store/migrations";
import { openDb } from "../src/store/db";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("migrations", () => {
  it("applies all 9 migrations to an in-memory db", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const rows = db
      .prepare("SELECT version FROM schema_versions ORDER BY version")
      .all() as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("creates the 4 expected tables", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("accounts");
    expect(tables).toContain("tokens");
    expect(tables).toContain("rate_limits");
    expect(tables).toContain("login_failures");
    expect(tables).toContain("schema_versions");
  });

  it("creates the 3 expected indexes", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indexes).toContain("idx_accounts_ord");
    expect(indexes).toContain("idx_tokens_updated");
    expect(indexes).toContain("idx_rate_limits_updated");
  });

  it("is idempotent — second call adds no rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM schema_versions")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(9);
  });
});

describe("openDb", () => {
  it("applies all 9 migrations via openDb(:memory:)", () => {
    const db = openDb(":memory:");
    const rows = db
      .prepare("SELECT version FROM schema_versions ORDER BY version")
      .all() as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });

  it("sets PRAGMA foreign_keys = ON", () => {
    const db = openDb(":memory:");
    const row = db.pragma("foreign_keys", { simple: true }) as number;
    expect(row).toBe(1);
    db.close();
  });

  it("file db is idempotent on re-open", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "qwen-db-"));
    const dbPath = path.join(tmpDir, "test.db");
    try {
      const db1 = openDb(dbPath);
      const rows1 = db1
        .prepare("SELECT COUNT(*) as cnt FROM schema_versions")
        .get() as { cnt: number };
      expect(rows1.cnt).toBe(9);
      db1.close();

      const db2 = openDb(dbPath);
      const rows2 = db2
        .prepare("SELECT COUNT(*) as cnt FROM schema_versions")
        .get() as { cnt: number };
      expect(rows2.cnt).toBe(9);
      db2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
