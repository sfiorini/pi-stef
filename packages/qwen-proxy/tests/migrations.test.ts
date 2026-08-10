import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/store/migrations";
import { openDb } from "../src/store/db";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("migrations", () => {
  it("applies all migrations to an in-memory db", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const rows = db
      .prepare("SELECT version FROM schema_versions ORDER BY version")
      .all() as { version: number }[];
    // v10/v12 gap is intentional (land in M2)
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
  });

  it("creates the 5 expected tables", () => {
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

  it("creates the 4 expected indexes", () => {
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
    expect(indexes).toContain("idx_accounts_active");
  });

  it("v11 adds state and re_enable_at columns to accounts", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(accounts)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("state");
    expect(colNames).toContain("re_enable_at");
  });

  it("v11 adds re_enable_at column to rate_limits", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(rate_limits)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("re_enable_at");
  });

  it("is idempotent — second call adds no rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM schema_versions")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(10);
  });
});

describe("openDb", () => {
  it("applies all migrations via openDb(:memory:)", () => {
    const db = openDb(":memory:");
    const rows = db
      .prepare("SELECT version FROM schema_versions ORDER BY version")
      .all() as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
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
      expect(rows1.cnt).toBe(10);
      db1.close();

      const db2 = openDb(dbPath);
      const rows2 = db2
        .prepare("SELECT COUNT(*) as cnt FROM schema_versions")
        .get() as { cnt: number };
      expect(rows2.cnt).toBe(10);
      db2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
