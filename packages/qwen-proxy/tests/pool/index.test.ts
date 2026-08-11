import { describe, it, expect } from "vitest";
import {
  PoolExhaustedError,
  AccountPool,
  atomicSwitch,
  withPoolRetry,
  withPoolRetryStream,
  ReenableDaemon,
} from "../../src/pool/index";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("pool barrel exports", () => {
  it("exports PoolExhaustedError", () => {
    expect(PoolExhaustedError).toBeDefined();
    const err = new PoolExhaustedError(123);
    expect(err).toBeInstanceOf(PoolExhaustedError);
    expect(err.earliestReEnableAt).toBe(123);
  });

  it("exports AccountPool", () => {
    expect(AccountPool).toBeDefined();
    expect(typeof AccountPool).toBe("function");
  });

  it("exports atomicSwitch", () => {
    expect(atomicSwitch).toBeDefined();
    expect(typeof atomicSwitch).toBe("function");
  });

  it("exports withPoolRetry", () => {
    expect(withPoolRetry).toBeDefined();
    expect(typeof withPoolRetry).toBe("function");
  });

  it("exports withPoolRetryStream", () => {
    expect(withPoolRetryStream).toBeDefined();
    expect(typeof withPoolRetryStream).toBe("function");
  });

  it("exports ReenableDaemon", () => {
    expect(ReenableDaemon).toBeDefined();
    expect(typeof ReenableDaemon).toBe("function");
  });
});

describe("bin-equivalent smoke (in-memory DB)", () => {
  it("constructs AccountPool + ReenableDaemon, hydrate + start/stop without throwing", async () => {
    // This mirrors bin/qwen-proxy.ts wiring:
    // reconcileAccounts → new AccountPool → hydrate → new ReenableDaemon → start → stop
    const { openDb } = await import("../../src/store/db");
    const { reconcileAccounts, upsertToken } = await import("../../src/store/repo");

    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);

    // Pool + hydrate (after reconcile, before routes)
    const pool = new AccountPool({ db, log: noopLog });
    pool.hydrate();

    // Insert a token so getActiveAccount works
    upsertToken(db, 1, "bearer-1", 999999);

    // ReenableDaemon + start
    const reenableDaemon = new ReenableDaemon({
      pool,
      intervalMs: 60_000,
      log: noopLog,
    });
    reenableDaemon.start();

    // Shutdown order: reenableDaemon.stop FIRST (before scheduler/db)
    reenableDaemon.stop();

    // Verify pool has an active account
    const acct = pool.getActiveAccount();
    expect(acct.id).toBe(1); // lowest ord

    db.close();
  });

  it("empty accounts at boot → hydrate leaves activeId=null, getActiveAccount throws", async () => {
    const { openDb } = await import("../../src/store/db");
    const { reconcileAccounts } = await import("../../src/store/repo");

    const db = openDb(":memory:");
    reconcileAccounts(db, []);

    const pool = new AccountPool({ db, log: noopLog });
    pool.hydrate();

    expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);

    db.close();
  });
});
