import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/store/migrations";

describe("applyMigrations", () => {
  it("applies all v1 migrations and records schema_versions", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const versions = db.prepare("SELECT version FROM schema_versions ORDER BY version").all() as { version: number }[];
    expect(versions.at(-1)!.version).toBe(8);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get()).toBeTruthy();
  });

  it("is idempotent and incremental — a second call adds nothing", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const before = (db.prepare("SELECT COUNT(*) n FROM schema_versions").get() as { n: number }).n;
    applyMigrations(db);
    const after = (db.prepare("SELECT COUNT(*) n FROM schema_versions").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
