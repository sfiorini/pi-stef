import type { AccountPool } from "./state";

export interface ReenableDaemonDeps {
  pool: AccountPool;
  intervalMs: number;
  log: { info: (msg: string, ctx?: unknown) => void };
  now?: () => number;
}

/**
 * Periodic sweep that re-enables expired cooldown accounts.
 * Mirrors CookieJar idempotent start()/stop() pattern.
 */
export class ReenableDaemon {
  private pool: AccountPool;
  private intervalMs: number;
  private log: ReenableDaemonDeps["log"];
  private now: () => number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ReenableDaemonDeps) {
    this.pool = deps.pool;
    this.intervalMs = deps.intervalMs;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Run one sweep immediately. */
  tick(): void {
    const result = this.pool.reEnableExpired(this.now());
    this.log.info("reenable sweep", {
      cleared: result.cleared,
      promoted: result.promoted,
    });
  }

  /** Start the periodic sweep interval. Idempotent — double start is a no-op. */
  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  /** Stop the periodic sweep. Safe if never started. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
