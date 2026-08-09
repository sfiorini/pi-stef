import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/store/migrations";

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
