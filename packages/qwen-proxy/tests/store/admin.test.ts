import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/store/db";
import {
  reconcileAccounts,
  upsertToken,
  setRateLimit,
  recordLoginFailure,
} from "../../src/store/repo";
import {
  listAccountsForAdmin,
  listTokensForAdmin,
  listRateLimitsForAdmin,
  listRecentLoginFailures,
  countLoginFailuresByAccount,
  getActiveAccountId,
} from "../../src/store/admin";
import type { Account } from "../../src/config/types";
import type Database from "better-sqlite3";

const accounts: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
  { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
];

function seedAccounts(db: Database.Database): void {
  reconcileAccounts(db, accounts);
}

describe("admin store helpers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  // ── listAccountsForAdmin ────────────────────────────────────────────────

  describe("listAccountsForAdmin", () => {
    it("returns empty array when no accounts exist", () => {
      expect(listAccountsForAdmin(db)).toEqual([]);
    });

    it("returns all accounts ordered by ord, id", () => {
      seedAccounts(db);
      const rows = listAccountsForAdmin(db);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(1);
      expect(rows[0].email).toBe("a@test.com");
      expect(rows[0].ord).toBe(1);
      expect(rows[0].state).toBe("disabled"); // D12: new accounts default disabled
      expect(rows[0].re_enable_at).toBeNull();
      expect(rows[1].id).toBe(2);
    });

    it("includes state and re_enable_at fields", () => {
      seedAccounts(db);
      db.prepare(
        "UPDATE accounts SET state = 'active', re_enable_at = NULL WHERE id = 1",
      ).run();
      db.prepare(
        "UPDATE accounts SET state = 'disabled', re_enable_at = 9999 WHERE id = 2",
      ).run();

      const rows = listAccountsForAdmin(db);
      const r1 = rows.find((r) => r.id === 1)!;
      const r2 = rows.find((r) => r.id === 2)!;
      expect(r1.state).toBe("active");
      expect(r1.re_enable_at).toBeNull();
      expect(r2.state).toBe("disabled");
      expect(r2.re_enable_at).toBe(9999);
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      const first = listAccountsForAdmin(db);
      const second = listAccountsForAdmin(db);
      expect(first).toEqual(second);
    });
  });

  // ── listTokensForAdmin ──────────────────────────────────────────────────

  describe("listTokensForAdmin", () => {
    it("returns empty array when no tokens exist", () => {
      expect(listTokensForAdmin(db)).toEqual([]);
    });

    it("returns has_bearer as truthy/falsy (SQLite integer)", () => {
      seedAccounts(db);
      upsertToken(db, 1, "bearer-1", null);
      upsertToken(db, 2, "bearer-2", 1000);

      const rows = listTokensForAdmin(db);
      expect(rows).toHaveLength(2);
      // SQLite IS NOT NULL returns 0/1; tests use toBeTruthy/toBeFalsy
      expect(rows[0].has_bearer).toBeTruthy();
      expect(rows[1].has_bearer).toBeTruthy();
    });

    it("has_bearer is falsy when bearer is null", () => {
      seedAccounts(db);
      // Insert a token with null bearer via raw SQL
      db.prepare(
        "INSERT INTO tokens (account_id, bearer, expires_at, updated_at) VALUES (?, NULL, NULL, ?)",
      ).run(1, Date.now());

      const rows = listTokensForAdmin(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].has_bearer).toBeFalsy();
    });

    it("never returns bearer property (no credential leakage)", () => {
      seedAccounts(db);
      upsertToken(db, 1, "super-secret-bearer", null);

      const rows = listTokensForAdmin(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("bearer");
    });

    it("includes expires_at and updated_at", () => {
      seedAccounts(db);
      const now = Date.now();
      upsertToken(db, 1, "tok", now + 3600_000);

      const rows = listTokensForAdmin(db);
      expect(rows[0].expires_at).toBe(now + 3600_000);
      expect(rows[0].updated_at).toBeGreaterThanOrEqual(now);
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      upsertToken(db, 1, "tok", null);
      const first = listTokensForAdmin(db);
      const second = listTokensForAdmin(db);
      expect(first).toEqual(second);
    });
  });

  // ── listRateLimitsForAdmin ──────────────────────────────────────────────

  describe("listRateLimitsForAdmin", () => {
    it("returns empty array when no rate limits exist", () => {
      expect(listRateLimitsForAdmin(db)).toEqual([]);
    });

    it("returns rate limit rows with all fields", () => {
      seedAccounts(db);
      setRateLimit(db, 1, { last_429_at: 1000, retry_after_at: 2000, re_enable_at: 3000 });

      const rows = listRateLimitsForAdmin(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].account_id).toBe(1);
      expect(rows[0].last_429_at).toBe(1000);
      expect(rows[0].retry_after_at).toBe(2000);
      expect(rows[0].re_enable_at).toBe(3000);
      expect(rows[0].updated_at).toBeGreaterThanOrEqual(0);
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      setRateLimit(db, 1, { last_429_at: 1000 });
      const first = listRateLimitsForAdmin(db);
      const second = listRateLimitsForAdmin(db);
      expect(first).toEqual(second);
    });
  });

  // ── listRecentLoginFailures ─────────────────────────────────────────────

  describe("listRecentLoginFailures", () => {
    it("returns empty array when no failures exist", () => {
      expect(listRecentLoginFailures(db)).toEqual([]);
    });

    it("returns failures ordered by attempted_at DESC", () => {
      seedAccounts(db);
      // Use explicit timestamps to guarantee ordering
      const now = Date.now();
      db.prepare(
        "INSERT INTO login_failures (account_id, attempted_at, reason, status_code) VALUES (?, ?, ?, ?)",
      ).run(1, now - 1000, "first failure", 401);
      db.prepare(
        "INSERT INTO login_failures (account_id, attempted_at, reason, status_code) VALUES (?, ?, ?, ?)",
      ).run(2, now, "second failure", 403);

      const rows = listRecentLoginFailures(db);
      expect(rows).toHaveLength(2);
      // Most recent first
      expect(rows[0].attempted_at).toBe(now);
      expect(rows[0].account_id).toBe(2);
      expect(rows[0].reason).toBe("second failure");
      expect(rows[0].status_code).toBe(403);
      expect(rows[1].attempted_at).toBe(now - 1000);
      expect(rows[1].account_id).toBe(1);
    });

    it("respects limit parameter", () => {
      seedAccounts(db);
      for (let i = 0; i < 10; i++) {
        recordLoginFailure(db, 1, `failure ${i}`, 401);
      }

      const rows = listRecentLoginFailures(db, 3);
      expect(rows).toHaveLength(3);
    });

    it("defaults to limit 50", () => {
      seedAccounts(db);
      for (let i = 0; i < 55; i++) {
        recordLoginFailure(db, 1, `failure ${i}`, 401);
      }

      const rows = listRecentLoginFailures(db);
      expect(rows).toHaveLength(50);
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      recordLoginFailure(db, 1, "fail", 401);
      const first = listRecentLoginFailures(db);
      const second = listRecentLoginFailures(db);
      expect(first).toEqual(second);
    });
  });

  describe("countLoginFailuresByAccount", () => {
    it("returns empty array when no failures exist", () => {
      expect(countLoginFailuresByAccount(db, 0)).toEqual([]);
    });

    it("counts failures by account_id since a timestamp", () => {
      seedAccounts(db);
      const now = Date.now();
      recordLoginFailure(db, 1, "old fail");
      // Simulate an old failure by updating the timestamp
      db.prepare("UPDATE login_failures SET attempted_at = ? WHERE account_id = 1")
        .run(now - 100_000);
      recordLoginFailure(db, 1, "recent fail");
      recordLoginFailure(db, 2, "recent fail 2");

      const rows = countLoginFailuresByAccount(db, now - 50_000);
      expect(rows).toHaveLength(2);
      const r1 = rows.find((r) => r.account_id === 1)!;
      const r2 = rows.find((r) => r.account_id === 2)!;
      expect(r1.count).toBe(1); // only the recent one
      expect(r2.count).toBe(1);
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      recordLoginFailure(db, 1, "fail", 401);
      const first = countLoginFailuresByAccount(db, 0);
      const second = countLoginFailuresByAccount(db, 0);
      expect(first).toEqual(second);
    });
  });

  // ── getActiveAccountId ──────────────────────────────────────────────────

  describe("getActiveAccountId", () => {
    it("returns null when no accounts exist", () => {
      expect(getActiveAccountId(db)).toBeNull();
    });

    it("returns null when all accounts are disabled", () => {
      seedAccounts(db);
      // All new accounts default to disabled (D12)
      expect(getActiveAccountId(db)).toBeNull();
    });

    it("returns the active account id", () => {
      seedAccounts(db);
      db.prepare(
        "UPDATE accounts SET state = 'active' WHERE id = 1",
      ).run();
      expect(getActiveAccountId(db)).toBe(1);
    });

    it("returns first active account when multiple exist (shouldn't happen but defensive)", () => {
      seedAccounts(db);
      db.prepare("UPDATE accounts SET state = 'active' WHERE id IN (1, 2)").run();
      // This violates the partial unique index, but test the helper returns something
      const result = getActiveAccountId(db);
      expect(result).not.toBeNull();
    });

    it("is read-only (idempotent)", () => {
      seedAccounts(db);
      db.prepare("UPDATE accounts SET state = 'active' WHERE id = 1").run();
      const first = getActiveAccountId(db);
      const second = getActiveAccountId(db);
      expect(first).toEqual(second);
    });
  });
});
