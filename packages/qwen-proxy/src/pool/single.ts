/**
 * Single-account pool shim for guest mode.
 *
 * Implements PoolLike with a single virtual account (id=0, bearer="guest").
 * On rate-limit, the account is disabled for the cooldown period — there is
 * no failover target, so subsequent getActiveAccount() throws
 * PoolExhaustedError until the cooldown elapses.
 */

import type { PoolLike } from "./types";
import { PoolExhaustedError } from "./errors";
import type { Logger } from "../server/logger";

export interface SingleAccountPoolDeps {
  log: Logger;
  now?: () => number;
}

export class SingleAccountPool implements PoolLike {
  readonly id = 0;
  readonly bearer = "guest";
  private disabledUntil: number | null = null;

  constructor(private deps: SingleAccountPoolDeps) {}

  getActiveAccount(): { id: number; bearer: string; expiresAt: number | null } {
    const now = this.deps.now?.() ?? Date.now();
    if (this.disabledUntil !== null && now < this.disabledUntil) {
      throw new PoolExhaustedError(this.disabledUntil);
    }
    return { id: 0, bearer: "guest", expiresAt: null };
  }

  async markEmptyAndSwitch(
    _failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }> {
    const now = this.deps.now?.() ?? Date.now();
    this.disabledUntil = now + cooldownMs;
    return { newActiveId: null, earliestReEnableAt: this.disabledUntil };
  }

  markSuccess(): void {
    // No-op in guest mode (retained for PoolLike contract).
  }

  earliestReEnableAt(): number | null {
    return this.disabledUntil;
  }
}
