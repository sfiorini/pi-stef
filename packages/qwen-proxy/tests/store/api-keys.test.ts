import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/store/migrations";
import { isValidKey, touchLastUsed, constantTimeEquals } from "../../src/store/api-keys";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

describe("api-keys", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  describe("isValidKey", () => {
    it("returns true for a valid table key", () => {
      db.prepare(
        "INSERT INTO api_keys (key, label, created_at) VALUES (?, ?, ?)",
      ).run("sk-test-123", "test key", Date.now());

      expect(isValidKey(db, "sk-test-123", [])).toBe(true);
    });

    it("returns true for a valid env key", () => {
      expect(isValidKey(db, "sk-env-key", ["sk-env-key", "sk-other"])).toBe(true);
    });

    it("returns false for a revoked table key", () => {
      db.prepare(
        "INSERT INTO api_keys (key, label, created_at, revoked_at) VALUES (?, ?, ?, ?)",
      ).run("sk-revoked", "revoked key", Date.now(), Date.now());

      expect(isValidKey(db, "sk-revoked", [])).toBe(false);
    });

    it("returns false for an unknown key", () => {
      expect(isValidKey(db, "sk-unknown", [])).toBe(false);
    });

    it("returns false for an unknown key with empty env list", () => {
      expect(isValidKey(db, "sk-unknown", [])).toBe(false);
    });

    it("table key takes precedence — revoked table + valid env = valid (env wins)", () => {
      db.prepare(
        "INSERT INTO api_keys (key, label, created_at, revoked_at) VALUES (?, ?, ?, ?)",
      ).run("sk-both", "both key", Date.now(), Date.now());

      // revoked in table, but present in env → env wins → valid
      expect(isValidKey(db, "sk-both", ["sk-both"])).toBe(true);
    });
  });

  describe("touchLastUsed", () => {
    it("updates last_used_at for an existing key", () => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO api_keys (key, label, created_at) VALUES (?, ?, ?)",
      ).run("sk-touch", "touch key", now);

      touchLastUsed(db, "sk-touch");

      const row = db
        .prepare("SELECT last_used_at FROM api_keys WHERE key = ?")
        .get("sk-touch") as { last_used_at: number };
      expect(row.last_used_at).toBeGreaterThanOrEqual(now);
    });

    it("is a no-op for a nonexistent key", () => {
      // Should not throw
      touchLastUsed(db, "sk-nonexistent");

      const count = (
        db.prepare("SELECT COUNT(*) as cnt FROM api_keys").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    });
  });

  describe("constantTimeEquals", () => {
    it("returns true for equal strings", () => {
      expect(constantTimeEquals("secret", "secret")).toBe(true);
    });

    it("returns false for same-length different strings", () => {
      expect(constantTimeEquals("secret", "SECRET")).toBe(false);
    });

    it("returns false for different-length strings", () => {
      expect(constantTimeEquals("short", "much-longer-string")).toBe(false);
    });

    it("returns true for two empty strings", () => {
      expect(constantTimeEquals("", "")).toBe(true);
    });
  });
});
