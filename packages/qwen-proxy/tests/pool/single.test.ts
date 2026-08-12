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

  it("markRateLimitedAndSwitch → getActiveAccount throws PoolExhaustedError while cooldown active", async () => {
    let now = 1000;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });

    const result = await pool.markRateLimitedAndSwitch(0, 60_000);
    expect(result).toEqual({ newActiveId: null, earliestReEnableAt: 61_000 });

    // Still within cooldown
    now = 50_000;
    expect(() => pool.getActiveAccount()).toThrow(PoolExhaustedError);

    // Verify the error carries the right timestamp
    try {
      pool.getActiveAccount();
    } catch (err) {
      expect(err).toBeInstanceOf(PoolExhaustedError);
      expect((err as PoolExhaustedError).earliestReEnableAt).toBe(61_000);
    }
  });

  it("getActiveAccount succeeds again after cooldown elapses", async () => {
    let now = 1000;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });

    await pool.markRateLimitedAndSwitch(0, 60_000);

    // Advance past cooldown
    now = 62_000;
    const acct = pool.getActiveAccount();
    expect(acct).toEqual({ id: 0, bearer: "guest", expiresAt: null });
  });

  it("markRateLimitedAndSwitch returns {newActiveId:null, earliestReEnableAt}", async () => {
    let now = 5000;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });

    const result = await pool.markRateLimitedAndSwitch(0, 120_000);
    expect(result.newActiveId).toBeNull();
    expect(result.earliestReEnableAt).toBe(125_000);
  });

  it("earliestReEnableAt returns disabledUntil / null", async () => {
    let now = 1000;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });

    // Initially null (no cooldown)
    expect(pool.earliestReEnableAt()).toBeNull();

    // After rate-limit
    await pool.markRateLimitedAndSwitch(0, 60_000);
    expect(pool.earliestReEnableAt()).toBe(61_000);

    // After cooldown elapses — earliestReEnableAt still returns the (now-past) timestamp
    now = 70_000;
    expect(pool.earliestReEnableAt()).toBe(61_000);
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

  it("markRateLimitedAndSwitch does NOT escalate (flat)", async () => {
    let now = 0;
    const pool = new SingleAccountPool({ log: noopLog, now: () => now });
    const r1 = await pool.markRateLimitedAndSwitch(0, 86_400_000);
    now = 1_000;
    const r2 = await pool.markRateLimitedAndSwitch(0, 86_400_000);
    expect(r1.earliestReEnableAt).toBe(86_400_000);
    expect(r2.earliestReEnableAt).toBe(1_000 + 86_400_000); // flat, no doubling
  });
});
