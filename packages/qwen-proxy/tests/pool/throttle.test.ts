import { describe, it, expect } from "vitest";
import { RequestThrottle } from "../../src/pool/throttle";

describe("RequestThrottle", () => {
  it("first call never waits", async () => {
    const slept: number[] = [];
    const t = new RequestThrottle({
      minGapMs: 5000,
      jitterFraction: 0,
      now: () => 1000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    await t.waitFor(1);
    expect(slept).toEqual([]);
  });

  it("waits when the second call is within the gap (no jitter)", async () => {
    let now = 1000;
    const slept: number[] = [];
    const t = new RequestThrottle({
      minGapMs: 5000,
      jitterFraction: 0,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await t.waitFor(1); // first → records last=1000
    now = 1500; // 500ms later
    await t.waitFor(1); // gap 5000 − elapsed 500 → wait 4500
    expect(slept).toEqual([4500]);
  });

  it("does not wait when the gap has fully elapsed", async () => {
    let now = 1000;
    const slept: number[] = [];
    const t = new RequestThrottle({
      minGapMs: 5000,
      jitterFraction: 0,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    await t.waitFor(1); // last=1000
    now = 7000; // 6000ms later (> 5000)
    await t.waitFor(1); // no wait
    expect(slept).toEqual([]);
  });

  it("global pacing: waitFor(1) then waitFor(2) within gap sleeps", async () => {
    let now = 1000;
    const slept: number[] = [];
    const t = new RequestThrottle({
      minGapMs: 5000,
      jitterFraction: 0,
      now: () => now,
      sleep: (ms) => { slept.push(ms); now += ms; return Promise.resolve(); },
    });
    await t.waitFor(1);   // first dispatch → records last=1000
    now = 1500;           // 500ms later
    await t.waitFor(2);   // gap 5000 − 500 → wait 4500 (GLOBAL, not per-account)
    expect(slept).toEqual([4500]);
  });

  it("minGapMs=0 disables throttling entirely", async () => {
    const slept: number[] = [];
    const t = new RequestThrottle({
      minGapMs: 0,
      now: () => 1000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    await t.waitFor(1);
    await t.waitFor(1);
    expect(slept).toEqual([]);
  });

  it("jitter varies the gap within [gap*(1−j), gap*(1+j)]", async () => {
    const minGap = 5000;
    const jitter = 0.5;
    const waits: number[] = [];
    for (let i = 0; i < 200; i++) {
      let now = 1000;
      const t = new RequestThrottle({
        minGapMs: minGap,
        jitterFraction: jitter,
        now: () => now,
        sleep: (ms) => {
          waits.push(ms);
          now += ms;
          return Promise.resolve();
        },
      });
      await t.waitFor(7); // first call
      now = 1000; // immediate second call (elapsed 0)
      await t.waitFor(7); // waits ≈ gap * jittered factor
    }
    const lo = minGap * (1 - jitter);
    const hi = minGap * (1 + jitter);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(lo - 1);
      expect(w).toBeLessThanOrEqual(hi + 1);
    }
    // Actual variation (not all identical) — the whole point of jitter.
    expect(new Set(waits).size).toBeGreaterThan(1);
  });
});
