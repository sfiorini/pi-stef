/**
 * Minimal pool interface consumed by retry.ts.
 *
 * SingleAccountPool (guest shim) satisfies this interface. Retry logic
 * depends on these 5 methods.  The two "mark" variants distinguish real
 * 429s (flat cooldown) from empty completions (Baxia CAPTCHA flag, escalated).
 */
export interface PoolLike {
  getActiveAccount(): { id: number; bearer: string; expiresAt: number | null };
  /** Real 429: flat cooldown, NO escalation (preserves rateLimitCooldownMs). */
  markRateLimitedAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  /** Empty completion (likely Baxia CAPTCHA flag): escalates by consecutiveEmpties. */
  markEmptyAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  /** Healthy completion: resets the empty-escalation counter. */
  markSuccess(): void;
  earliestReEnableAt(): number | null;
}
