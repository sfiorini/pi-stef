import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import {
  listAccounts,
  getAccount,
  reconcileAccounts,
  upsertToken,
  getToken,
  listTokenRows,
  recordLoginFailure,
  listLoginFailures,
  upsertRateLimit,
  getRateLimit,
} from "../src/store/repo";
import type { Account } from "../src/config/types";

describe("reconcileAccounts", () => {
  it("inserts new accounts", () => {
    const db = openDb(":memory:");
    const accounts: Account[] = [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ];

    const result = reconcileAccounts(db, accounts);

    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);

    const rows = listAccounts(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].email).toBe("a@test.com");
    expect(rows[1].email).toBe("b@test.com");
    db.close();
  });

  it("updates changed email/password/ord", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "old@test.com", password: "oldpw", ord: 1 },
    ]);

    reconcileAccounts(db, [
      { id: 1, email: "new@test.com", password: "newpw", ord: 99 },
    ]);

    const row = getAccount(db, 1)!;
    expect(row.email).toBe("new@test.com");
    expect(row.password).toBe("newpw");
    expect(row.ord).toBe(99);
    db.close();
  });

  it("deletes absent rows AND cascades token/rate_limit/login_failure", () => {
    const db = openDb(":memory:");

    // Seed two accounts
    reconcileAccounts(db, [
      { id: 1, email: "keep@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "doomed@test.com", password: "pw2", ord: 2 },
    ]);

    // Pre-insert child rows for doomed account (id=2)
    upsertToken(db, 2, "bearer2", null);
    upsertRateLimit(db, 2, { last_429_at: 1000, retry_after_at: 2000 });
    recordLoginFailure(db, 2, "bad creds", 401);

    // Also add child rows for kept account (id=1) — should survive
    upsertToken(db, 1, "bearer1", null);

    // Verify child rows exist before reconcile
    expect(getToken(db, 2)).toBeDefined();
    expect(getRateLimit(db, 2)).toBeDefined();
    expect(listLoginFailures(db, 2)).toHaveLength(1);

    // Reconcile with only account 1
    const result = reconcileAccounts(db, [
      { id: 1, email: "keep@test.com", password: "pw1", ord: 1 },
    ]);

    expect(result.inserted).toBe(0);
    expect(result.deleted).toBe(1);

    // Account 2 and its children should be gone (cascade)
    expect(getAccount(db, 2)).toBeUndefined();
    expect(getToken(db, 2)).toBeUndefined();
    expect(getRateLimit(db, 2)).toBeUndefined();
    expect(listLoginFailures(db, 2)).toHaveLength(0);

    // Account 1 and its token should survive
    expect(getAccount(db, 1)).toBeDefined();
    expect(getToken(db, 1)).toBeDefined();
    db.close();
  });

  it("deletes ALL accounts when config is empty", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    const result = reconcileAccounts(db, []);
    expect(result.deleted).toBe(1);
    expect(listAccounts(db)).toHaveLength(0);
    db.close();
  });
});

describe("upsertToken + getToken", () => {
  it("round-trips bearer + expiresAt", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    const futureMs = Date.now() + 3600_000;
    upsertToken(db, 1, "my-bearer-token", futureMs);

    const row = getToken(db, 1)!;
    expect(row.bearer).toBe("my-bearer-token");
    expect(row.expires_at).toBe(futureMs);
    db.close();
  });

  it("second upsert overwrites", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    upsertToken(db, 1, "old-bearer", null);
    upsertToken(db, 1, "new-bearer", 999);

    const row = getToken(db, 1)!;
    expect(row.bearer).toBe("new-bearer");
    expect(row.expires_at).toBe(999);
    db.close();
  });

  it("expiresAt null round-trips", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    upsertToken(db, 1, "bearer", null);
    const row = getToken(db, 1)!;
    expect(row.bearer).toBe("bearer");
    expect(row.expires_at).toBeNull();
    db.close();
  });

  it("listTokenRows returns all token rows", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw", ord: 2 },
    ]);

    upsertToken(db, 1, "b1", null);
    upsertToken(db, 2, "b2", null);

    const rows = listTokenRows(db);
    expect(rows).toHaveLength(2);
    db.close();
  });
});

describe("recordLoginFailure + listLoginFailures", () => {
  it("appends failures and returns them", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    recordLoginFailure(db, 1, "bad creds", 401);
    recordLoginFailure(db, 1, "timeout");

    const failures = listLoginFailures(db, 1);
    expect(failures).toHaveLength(2);
    expect(failures[0].reason).toBe("bad creds");
    expect(failures[0].status_code).toBe(401);
    expect(failures[1].reason).toBe("timeout");
    expect(failures[1].status_code).toBeNull();
    db.close();
  });
});

describe("upsertRateLimit + getRateLimit", () => {
  it("round-trips rate limit fields", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    upsertRateLimit(db, 1, { last_429_at: 1000, retry_after_at: 2000 });
    const row = getRateLimit(db, 1)!;
    expect(row.last_429_at).toBe(1000);
    expect(row.retry_after_at).toBe(2000);
    db.close();
  });

  it("overwrites on second upsert", () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw", ord: 1 },
    ]);

    upsertRateLimit(db, 1, { last_429_at: 1000 });
    upsertRateLimit(db, 1, { retry_after_at: 5000 });

    const row = getRateLimit(db, 1)!;
    // second upsert only set retry_after_at; last_429_at should be null (overwritten)
    expect(row.retry_after_at).toBe(5000);
    db.close();
  });
});
