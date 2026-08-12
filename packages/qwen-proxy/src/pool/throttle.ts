/**
 * Global request pacer ("look human").
 *
 * Baxia (chat.qwen.ai's anti-bot) flags clients that fire rapid, metronomic
 * automated traffic. Enforcing a minimum gap — with random jitter — between
 * consecutive dispatches makes the proxy's cadence look organic, reducing how
 * often it gets CAPTCHA-flagged.
 *
 * Call `await throttle.waitFor(accountId)` immediately before each upstream
 * dispatch. The `_accountId` param is ignored (kept so retry.ts call sites
 * need zero changes). The first call never waits.
 */
export interface RequestThrottleDeps {
  /** Minimum gap between consecutive dispatches to the same account, in ms. 0 disables. */
  minGapMs: number;
  /** Jitter as a fraction of the gap (e.g. 0.5 → gap × [0.5..1.5]). Default 0.5. */
  jitterFraction?: number;
  /** Inject now() for tests. */
  now?: () => number;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RequestThrottle {
  private readonly minGapMs: number;
  private readonly jitterFraction: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastDispatchAt: number | null = null;

  constructor(deps: RequestThrottleDeps) {
    this.minGapMs = Math.max(0, deps.minGapMs);
    this.jitterFraction = deps.jitterFraction ?? 0.5;
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Block until the global minimum gap (±jitter) has elapsed. */
  async waitFor(_accountId: number): Promise<void> {
    if (this.minGapMs <= 0) return;
    const last = this.lastDispatchAt;
    const t = this.now();
    if (last === null) {
      this.lastDispatchAt = t;
      return;
    }
    // Randomize the gap so the cadence isn't metronomic.
    const jitter =
      this.jitterFraction > 0
        ? 1 + (Math.random() * 2 - 1) * this.jitterFraction
        : 1;
    const gap = Math.round(this.minGapMs * jitter);
    const wait = gap - (t - last);
    if (wait > 0) {
      await this.sleep(wait);
    }
    this.lastDispatchAt = this.now();
  }
}
