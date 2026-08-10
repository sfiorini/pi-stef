import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { ReenableDaemon } from "../../src/pool/reenable-daemon";
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

describe("ReenableDaemon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tick() clears expired cooldown (back-of-queue) when active exists", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=2",
    ).run();
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=3",
    ).run();

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });
    daemon.tick();

    // Account 2 (re_enable_at=50 ≤ now=100) → cleared
    const r2 = db
      .prepare("SELECT state, re_enable_at FROM accounts WHERE id=2")
      .get() as { state: string; re_enable_at: number | null };
    expect(r2.state).toBe("disabled");
    expect(r2.re_enable_at).toBeNull(); // back-of-queue

    // Account 3 still in cooldown
    const r3 = db
      .prepare("SELECT re_enable_at FROM accounts WHERE id=3")
      .get() as { re_enable_at: number | null };
    expect(r3.re_enable_at).toBe(99999);

    // Account 1 still active
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("tick() promotes one when no active (self-heal)", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    // All disabled, one expired
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=50 WHERE id=2",
    ).run();
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=1",
    ).run();
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=3",
    ).run();

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });
    daemon.tick();

    // Account 2 promoted to active
    const r2 = db
      .prepare("SELECT state FROM accounts WHERE id=2")
      .get() as { state: string };
    expect(r2.state).toBe("active");
    expect(activeCount(db)).toBe(1);
    db.close();
  });

  it("tick() no re-enable of in-cooldown accounts", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    db.prepare(
      "UPDATE accounts SET state='disabled', re_enable_at=99999 WHERE id=2",
    ).run();

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });
    daemon.tick();

    // Account 2 still in cooldown
    const r2 = db
      .prepare("SELECT state, re_enable_at FROM accounts WHERE id=2")
      .get() as { state: string; re_enable_at: number | null };
    expect(r2.state).toBe("disabled");
    expect(r2.re_enable_at).toBe(99999);
    db.close();
  });

  it("start()/stop() manages interval", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const tickSpy = vi.fn();
    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });
    // Override tick for this test
    (daemon as unknown as { tick: () => void }).tick = tickSpy;

    daemon.start();
    expect(tickSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(60_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    daemon.stop();
    vi.advanceTimersByTime(120_000);
    // No more calls after stop
    expect(tickSpy).toHaveBeenCalledTimes(2);

    db.close();
  });

  it("start() is idempotent — double start doesn't leak interval", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const tickSpy = vi.fn();
    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });
    (daemon as unknown as { tick: () => void }).tick = tickSpy;

    daemon.start();
    daemon.start(); // second start should be no-op

    vi.advanceTimersByTime(60_000);
    expect(tickSpy).toHaveBeenCalledTimes(1); // only one interval running

    daemon.stop();
    db.close();
  });

  it("stop() is safe if never started", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);

    const pool = new AccountPool({ db, log: noopLog, now: () => 10 });
    pool.hydrate();

    const daemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
      now: () => 100,
    });

    // stop without start — should not throw
    expect(() => daemon.stop()).not.toThrow();
    db.close();
  });
});
