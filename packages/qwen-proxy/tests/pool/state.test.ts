import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { PoolExhaustedError } from "../../src/pool/errors";
import type { Account } from "../../src/config/types";
import type { Logger } from "../../src/server/logger";

const ACCOUNTS: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
  { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
  { id: 3, email: "c@test.com", password: "pw3", ord: 3 },
];

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function promote(db: Database.Database, id: number) {
  db.prepare(
    "UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=?",
  ).run(id);
}

function activeCount(db: Database.Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) as cnt FROM accounts WHERE state='active'")
      .get() as { cnt: number }
  ).cnt;
}

describe("AccountPool", () => {
  // ── hydrate ────────────────────────────────────────────────────────────

  describe("hydrate", () => {
    it("reads existing active on restart", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 2); // account 2 is active

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      // getActiveAccount should return account 2
      upsertToken(db, 2, "bearer-2", 999999);
      const acct = pool.getActiveAccount();
      expect(acct.id).toBe(2);
      expect(acct.bearer).toBe("bearer-2");
      db.close();
    });

    it("promotes lowest-ord eligible when no active", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      // All are disabled by default after reconcile (no promote)

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      upsertToken(db, 1, "bearer-1", 999999);
      const acct = pool.getActiveAccount();
      expect(acct.id).toBe(1); // lowest ord
      db.close();
    });

    it("activeId=null when all disabled with cooldown", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      // Put all in cooldown (future re_enable_at)
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id IN (1,2,3)",
      ).run();

      // now=10 so all re_enable_at (99999) > now → none eligible
      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate();

      expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);
      db.close();
    });

    it("empty table → activeId=null, getActiveAccount throws", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, []);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);
      db.close();
    });
  });

  // ── getActiveAccount ───────────────────────────────────────────────────

  describe("getActiveAccount", () => {
    it("returns id + bearer + expiresAt", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);
      upsertToken(db, 1, "bearer-xyz", 12345);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      const acct = pool.getActiveAccount();
      expect(acct.id).toBe(1);
      expect(acct.bearer).toBe("bearer-xyz");
      expect(acct.expiresAt).toBe(12345);
      db.close();
    });

    it("throws PoolExhaustedError when no bearer (token missing)", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);
      // No token inserted

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);
      db.close();
    });

    it("throws PoolExhaustedError with earliestReEnableAt from DB", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, [
        { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
        { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
      ]);
      // Put both in cooldown
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=500 WHERE id=1",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=300 WHERE id=2",
      ).run();

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      try {
        pool.getActiveAccount();
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PoolExhaustedError);
        expect((e as PoolExhaustedError).earliestReEnableAt).toBe(300);
      }
      db.close();
    });
  });

  // ── markRateLimitedAndSwitch ───────────────────────────────────────────

  describe("markRateLimitedAndSwitch", () => {
    it("demotes failed, promotes next, updates activeId", async () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);
      upsertToken(db, 2, "bearer-2", 999999);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      const result = await pool.markRateLimitedAndSwitch(1, 1000);
      expect(result.newActiveId).toBe(2);

      // Now getActiveAccount should return account 2
      const acct = pool.getActiveAccount();
      expect(acct.id).toBe(2);
      db.close();
    });

    it("returns newActiveId=null when exhausted", async () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, [
        { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      ]);
      promote(db, 1);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      const result = await pool.markRateLimitedAndSwitch(1, 1000);
      expect(result.newActiveId).toBeNull();
      expect(result.earliestReEnableAt).toBeGreaterThan(0);
      db.close();
    });

    it("serializes concurrent switches via mutex", async () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      // Fire two concurrent switches for the same account
      await Promise.all([
        pool.markRateLimitedAndSwitch(1, 1000),
        pool.markRateLimitedAndSwitch(1, 1000),
      ]);

      // First should succeed, second should be a no-op (double-check inside atomicSwitch)
      // Only one actual switch should happen
      expect(activeCount(db)).toBe(1);
      db.close();
    });

    it("A1: clears activeId on exhaustion so reEnableExpired can recover", async () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, [
        { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      ]);
      promote(db, 1);

      let now = 1000;
      const pool = new AccountPool({ db, log: noopLog, now: () => now });
      pool.hydrate();

      // Exhaust the only account
      const result = await pool.markRateLimitedAndSwitch(1, 10_000);
      expect(result.newActiveId).toBeNull();

      // activeId must be null now — getActiveAccount must throw
      expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);

      // Advance past cooldown
      now = 15_000;
      const reResult = pool.reEnableExpired(now);
      expect(reResult.promoted).toBe(1);

      // Pool should recover — getActiveAccount succeeds
      upsertToken(db, 1, "bearer-after-recovery", 999999);
      const acct = pool.getActiveAccount();
      expect(acct.id).toBe(1);
      expect(acct.bearer).toBe("bearer-after-recovery");
      db.close();
    });
  });

  // ── reEnableExpired ────────────────────────────────────────────────────

  describe("reEnableExpired", () => {
    it("clears cooldown when active exists (back-of-queue)", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);

      // Put accounts 2 and 3 in cooldown, one expired one not
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=2",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=3",
      ).run();

      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate();

      const result = pool.reEnableExpired(100);
      // Account 2 has re_enable_at=50 <= 100, so cleared
      // Account 3 has re_enable_at=99999 > 100, not cleared
      expect(result.cleared).toBe(1);
      expect(result.promoted).toBe(0); // active exists, so no promotion

      // Account 2 should now be disabled with null re_enable_at (back-of-queue)
      const r2 = db
        .prepare("SELECT state, re_enable_at FROM accounts WHERE id=2")
        .get() as { state: string; re_enable_at: number | null };
      expect(r2.state).toBe("disabled");
      expect(r2.re_enable_at).toBeNull();

      // Account 1 still active
      expect(activeCount(db)).toBe(1);
      db.close();
    });

    it("promotes one when no active exists (self-heal)", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      // All disabled, account 2 expired cooldown
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=2",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=1",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=3",
      ).run();

      // now=10 so all re_enable_at > now during hydrate → none eligible
      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate(); // activeId = null (all in cooldown)

      const result = pool.reEnableExpired(100);
      expect(result.cleared).toBe(1); // account 2 expired
      expect(result.promoted).toBe(1); // account 2 promoted (only one eligible)

      // Account 2 should be active now
      const r2 = db
        .prepare("SELECT state FROM accounts WHERE id=2")
        .get() as { state: string };
      expect(r2.state).toBe("active");
      expect(activeCount(db)).toBe(1);
      db.close();
    });

    it("F5: promotes one and clears others when multiple expired + no active", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      // All disabled, accounts 2 and 3 both expired
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=2",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=60 WHERE id=3",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=1",
      ).run();

      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate(); // activeId = null (all in cooldown)

      const result = pool.reEnableExpired(100);
      // Account 2 promoted (first eligible), account 3 cleared (cooldown removed)
      expect(result.cleared).toBe(2);
      expect(result.promoted).toBe(1);

      // Account 2 should be active
      const r2 = db
        .prepare("SELECT state, re_enable_at FROM accounts WHERE id=2")
        .get() as { state: string; re_enable_at: number | null };
      expect(r2.state).toBe("active");
      expect(r2.re_enable_at).toBeNull();

      // Account 3 should be disabled but cooldown cleared (back-of-queue)
      const r3 = db
        .prepare("SELECT state, re_enable_at FROM accounts WHERE id=3")
        .get() as { state: string; re_enable_at: number | null };
      expect(r3.state).toBe("disabled");
      expect(r3.re_enable_at).toBeNull();

      expect(activeCount(db)).toBe(1);
      db.close();
    });

    it("no re-enable of in-cooldown accounts", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);

      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=2",
      ).run();

      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate();

      const result = pool.reEnableExpired(100);
      expect(result.cleared).toBe(0);
      expect(result.promoted).toBe(0);
      db.close();
    });
  });

  // ── earliestReEnableAt ─────────────────────────────────────────────────

  describe("earliestReEnableAt", () => {
    it("returns MIN(re_enable_at) among disabled", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);

      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=500 WHERE id=2",
      ).run();
      db.prepare(
        "UPDATE accounts SET state='disabled', re_enable_at=300 WHERE id=3",
      ).run();

      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate();

      expect(pool.earliestReEnableAt()).toBe(300);
      db.close();
    });

    it("returns null when no disabled accounts with re_enable_at", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, ACCOUNTS);
      promote(db, 1);
      // 2 and 3 are disabled but no re_enable_at

      const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
      pool.hydrate();

      expect(pool.earliestReEnableAt()).toBeNull();
      db.close();
    });

    it("returns null when no disabled accounts at all", () => {
      const db = openDb(":memory:");
      reconcileAccounts(db, [
        { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      ]);
      promote(db, 1);

      const pool = new AccountPool({ db, log: noopLog });
      pool.hydrate();

      expect(pool.earliestReEnableAt()).toBeNull();
      db.close();
    });
  });
});
