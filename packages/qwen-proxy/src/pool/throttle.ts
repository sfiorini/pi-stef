/**
 * Per-account request pacer ("look human").
 *
 * Baxia (chat.qwen.ai's anti-bot) flags accounts that fire rapid, metronomic
 * automated traffic. Enforcing a minimum gap — with random jitter — between
 * consecutive dispatches to the SAME account makes the proxy's cadence look
 * organic, reducing how often an account gets CAPTCHA-flagged.
 *
 * Call `await throttle.waitFor(accountId)` immediately before each upstream
 * dispatch. The first call to an account never waits.
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
  private readonly lastDispatchAt = new Map<number, number>();

  constructor(deps: RequestThrottleDeps) {
    this.minGapMs = Math.max(0, deps.minGapMs);
    this.jitterFraction = deps.jitterFraction ?? 0.5;
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Block until the per-account minimum gap (±jitter) has elapsed. */
  async waitFor(accountId: number): Promise<void> {
    if (this.minGapMs <= 0) return;
    const last = this.lastDispatchAt.get(accountId);
    const t = this.now();
    if (last === undefined) {
      this.lastDispatchAt.set(accountId, t);
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
    this.lastDispatchAt.set(accountId, this.now());
  }
}
