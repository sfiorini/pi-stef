import { describe, it, expect } from "vitest";
import { openDb } from "../../src/store/db";
import { reconcileAccounts } from "../../src/store/repo";
import { atomicSwitch } from "../../src/pool/switch";
import type { Account } from "../../src/config/types";

const ACCOUNTS: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
  { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
  { id: 3, email: "c@test.com", password: "pw3", ord: 3 },
];

/** Helper: promote one account to 'active' (after reconcile inserts all as disabled) */
function promote(db: import("better-sqlite3").Database, id: number) {
  db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=?").run(id);
}

/** Helper: get the active count */
function activeCount(db: import("better-sqlite3").Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) as cnt FROM accounts WHERE state='active'")
      .get() as { cnt: number }
  ).cnt;
}

describe("atomicSwitch", () => {
  it("demote → pick-next → promote", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    // account 1 is active, switch to next
    const result = atomicSwitch(db, 1, 1000, 100);

    // account 2 should now be active (lowest ord eligible)
    expect(result.newActiveId).toBe(2);
    expect(result.earliestReEnableAt).toBeNull();

    // account 1 should be disabled with re_enable_at = 100 + 1000 = 1100
    const r1 = db
      .prepare("SELECT state, re_enable_at FROM accounts WHERE id=1")
      .get() as { state: string; re_enable_at: number | null };
    expect(r1.state).toBe("disabled");
    expect(r1.re_enable_at).toBe(1100);

    // account 2 should be active
    const r2 = db
      .prepare("SELECT state FROM accounts WHERE id=2")
      .get() as { state: string };
    expect(r2.state).toBe("active");

    // exactly one active
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("double-check no-op: active already differs → return current", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 2); // account 2 is active

    // try to switch from account 1 (not active) → no-op
    const result = atomicSwitch(db, 1, 1000, 100);

    expect(result.newActiveId).toBe(2); // returns current active
    expect(result.earliestReEnableAt).toBeNull();

    // account 2 still active, account 1 still disabled
    const r2 = db
      .prepare("SELECT state FROM accounts WHERE id=2")
      .get() as { state: string };
    expect(r2.state).toBe("active");
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("exhausted: no eligible → newActiveId:null + earliestReEnableAt", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    promote(db, 1);

    // Put account 2 in cooldown (re_enable_at in the future)
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=500 WHERE id=2",
    ).run();

    const result = atomicSwitch(db, 1, 1000, 100);

    expect(result.newActiveId).toBeNull();
    // earliestReEnableAt should be MIN(re_enable_at) among disabled = min(1100, 500) = 500
    expect(result.earliestReEnableAt).toBe(500);

    // no active accounts
    expect(activeCount(db)).toBe(0);
    db.close();
  });

  it("picks eligible (re_enable_at null) over in-cooldown", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    // account 2 in cooldown, account 3 eligible (no re_enable_at)
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=9999 WHERE id=2",
    ).run();

    const result = atomicSwitch(db, 1, 1000, 100);

    // should pick account 3 (eligible: disabled, re_enable_at IS NULL)
    expect(result.newActiveId).toBe(3);
    expect(result.earliestReEnableAt).toBeNull();
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("picks eligible (re_enable_at <= now) over in-cooldown", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    // account 2 in cooldown (future), account 3 expired cooldown (past)
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=9999 WHERE id=2",
    ).run();
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=3",
    ).run();

    const result = atomicSwitch(db, 1, 1000, 100);

    // account 3 has re_enable_at=50 <= now=100, so eligible
    expect(result.newActiveId).toBe(3);
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("invariant: exactly 1 active after each switch (or 0 when exhausted)", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    // Switch 1→2
    atomicSwitch(db, 1, 1000, 100);
    expect(activeCount(db)).toBe(1);

    // Switch 2→3
    atomicSwitch(db, 2, 1000, 200);
    expect(activeCount(db)).toBe(1);

    // Switch 3→exhausted (1 and 2 are in cooldown)
    const r3 = atomicSwitch(db, 3, 1000, 300);
    // 1 re_enable_at = 100+1000=1100, 2 re_enable_at = 200+1000=1200
    expect(r3.newActiveId).toBeNull();
    expect(r3.earliestReEnableAt).toBe(1100);
    expect(activeCount(db)).toBe(0);
    db.close();
  });

  it("upserts rate_limits row with last_429_at, retry_after_at, re_enable_at", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    atomicSwitch(db, 1, 5000, 200);

    const rl = db
      .prepare("SELECT * FROM rate_limits WHERE account_id=1")
      .get() as {
      last_429_at: number | null;
      retry_after_at: number | null;
      re_enable_at: number | null;
    };
    expect(rl.last_429_at).toBe(200);
    expect(rl.retry_after_at).toBeNull();
    expect(rl.re_enable_at).toBe(200 + 5000); // now + cooldownMs
    db.close();
  });

  it("single account: demote self, no eligible → exhausted", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
    ]);
    promote(db, 1);

    const result = atomicSwitch(db, 1, 1000, 100);
    expect(result.newActiveId).toBeNull();
    expect(result.earliestReEnableAt).toBe(1100);
    expect(activeCount(db)).toBe(0);
    db.close();
  });
});
