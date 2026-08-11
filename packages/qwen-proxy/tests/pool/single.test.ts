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
