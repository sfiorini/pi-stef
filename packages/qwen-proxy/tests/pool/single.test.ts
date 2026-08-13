import { describe, it, expect } from "vitest";
import { SingleAccountPool } from "../../src/pool/single";
import { PoolExhaustedError } from "../../src/pool/errors";
import type { Logger } from "../../src/server/logger";

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("SingleAccountPool", () => {
  it("getActiveAccount returns {id:0, bearer:'guest', expiresAt:null}", () => {
    const pool = new SingleAccountPool({ log: noopLog });
    const acct = pool.getActiveAccount();
    expect(acct).toEqual({ id: 0, bearer: "guest", expiresAt: null });
  });
});

describe("SingleAccountPool flat empty-cooldown", () => {
  it("markEmptyAndSwitch applies flat cooldown each time (no escalation)", async () => {
    let now = 0;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });
    // Use a cooldownMs that would differ if escalation existed (BASE=90000 * 2^n)
    const cooldownMs = 600_000;
    const r1 = await pool.markEmptyAndSwitch(0, cooldownMs);
    now = 1_000;
    const r2 = await pool.markEmptyAndSwitch(0, cooldownMs);
    now = 2_000;
    const r3 = await pool.markEmptyAndSwitch(0, cooldownMs);
    // Flat each time: now + cooldownMs (no escalation)
    expect(r1.earliestReEnableAt).toBe(600_000);
    expect(r2.earliestReEnableAt).toBe(601_000);
    expect(r3.earliestReEnableAt).toBe(602_000);
  });

  it("markSuccess is a no-op (does not change the cooldown)", async () => {
    let now = 0;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });
    await pool.markEmptyAndSwitch(0, 10_000); // disabledUntil = 10_000
    pool.markSuccess(); // should not affect disabledUntil
    // cooldown still applies
    expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);
    now = 11_000;
    expect(pool.getActiveAccount()).toEqual({ id: 0, bearer: "guest", expiresAt: null });
  });
});
