import type Database from "better-sqlite3";
import type { Logger } from "../server/logger";
import { getToken } from "../store/repo";
import { PoolExhaustedError } from "./errors";
import { atomicSwitch, type SwitchResult } from "./switch";

export interface ActiveAccount {
  id: number;
  bearer: string;
  expiresAt: number | null;
}

export interface AccountPoolDeps {
  db: Database.Database;
  log: Logger;
  now?: () => number;
}

export class AccountPool {
  private activeId: number | null = null;
  private mutex: Promise<SwitchResult> = Promise.resolve({
    newActiveId: null,
    earliestReEnableAt: null,
  });

  constructor(private deps: AccountPoolDeps) {}

  /** Startup hydration (after reconcileAccounts, before routes mount). */
  hydrate(): void {
    const active = this.deps.db
      .prepare("SELECT id FROM accounts WHERE state = 'active' LIMIT 1")
      .get() as { id: number } | undefined;
    if (active) {
      this.activeId = active.id;
      return;
    }
    this.promoteEligible();
  }

  /** Return the current active account + its live bearer. Throws if exhausted. */
  getActiveAccount(): ActiveAccount {
    if (this.activeId === null)
      throw new PoolExhaustedError(this.earliestReEnableAt());
    const token = getToken(this.deps.db, this.activeId);
    if (!token?.bearer)
      throw new PoolExhaustedError(this.earliestReEnableAt());
    return {
      id: this.activeId,
      bearer: token.bearer,
      expiresAt: token.expires_at,
    };
  }

  /**
   * Mark failedId rate-limited, atomically switch to next eligible, update pointer.
   * Serialized via mutex + double-check inside atomicSwitch.
   */
  async markRateLimitedAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<SwitchResult> {
    const now = this.deps.now?.() ?? Date.now();
    const run = this.mutex.then(() =>
      atomicSwitch(this.deps.db, failedId, cooldownMs, now),
    );
    // Chain: even if the switch throws, keep mutex going
    this.mutex = run.catch(
      () =>
        ({
          newActiveId: null,
          earliestReEnableAt: null,
        }) as SwitchResult,
    );
    const result = await run;
    if (result.newActiveId !== null) this.activeId = result.newActiveId;
    return result;
  }

  /**
   * Re-enable sweep (called by daemon every interval).
   * For each disabled account with re_enable_at <= now:
   *   - If an active exists: clear its cooldown (back-of-queue, now eligible).
   *   - If NO active: promote ONE (self-heal).
   */
  reEnableExpired(
    now: number = Date.now(),
  ): { cleared: number; promoted: number } {
    const expired = this.deps.db
      .prepare(
        `SELECT id FROM accounts
         WHERE state = 'disabled' AND re_enable_at IS NOT NULL AND re_enable_at <= ?
         ORDER BY ord ASC, id ASC`,
      )
      .all(now) as { id: number }[];

    let cleared = 0;
    let promoted = 0;
    const hasActive = this.activeId !== null;

    for (const row of expired) {
      if (hasActive) {
        // Clear cooldown → back-of-queue (stays disabled, now eligible)
        this.deps.db
          .prepare(
            "UPDATE accounts SET state = 'disabled', re_enable_at = NULL WHERE id = ? AND state = 'disabled'",
          )
          .run(row.id);
        cleared++;
      } else if (promoted === 0) {
        // No active → promote the first expired eligible
        this.deps.db
          .prepare(
            "UPDATE accounts SET state = 'active', re_enable_at = NULL WHERE id = ?",
          )
          .run(row.id);
        this.activeId = row.id;
        promoted++;
        cleared++; // also counts as "cleared" the cooldown
      }
    }

    return { cleared, promoted };
  }

  /** Promote the lowest-ord eligible account to 'active'. */
  private promoteEligible(): void {
    const eligible = this.deps.db
      .prepare(
        `SELECT id FROM accounts
         WHERE state = 'disabled'
           AND (re_enable_at IS NULL OR re_enable_at <= ?)
         ORDER BY ord ASC, id ASC
         LIMIT 1`,
      )
      .get(this.deps.now?.() ?? Date.now()) as { id: number } | undefined;

    if (eligible) {
      this.deps.db
        .prepare(
          "UPDATE accounts SET state = 'active', re_enable_at = NULL WHERE id = ?",
        )
        .run(eligible.id);
      this.activeId = eligible.id;
    }
  }

  /** MIN(re_enable_at) among disabled accounts — for Retry-After. */
  earliestReEnableAt(): number | null {
    const row = this.deps.db
      .prepare(
        `SELECT MIN(re_enable_at) as min_re FROM accounts
         WHERE state = 'disabled' AND re_enable_at IS NOT NULL`,
      )
      .get() as { min_re: number | null };
    return row?.min_re ?? null;
  }
}
