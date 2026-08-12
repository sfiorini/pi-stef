/**
 * Minimal pool interface consumed by retry.ts.
 *
 * SingleAccountPool (guest shim) satisfies this interface. Retry logic
 * depends on these 5 methods.  The two "mark" variants distinguish real
 * 429s (flat cooldown) from empty completions (Baxia CAPTCHA flag, flat short
 * cooldown after inline-retry exhaustion).
 */
export interface PoolLike {
  getActiveAccount(): { id: number; bearer: string; expiresAt: number | null };
  /** Real 429: flat cooldown, NO escalation (preserves rateLimitCooldownMs). */
  markRateLimitedAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  /** Empty completion (Baxia CAPTCHA flag, AFTER inline-retry exhaustion): flat short cooldown. */
  markEmptyAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  /** Healthy completion. No-op in guest mode (retained for PoolLike). */
  markSuccess(): void;
  earliestReEnableAt(): number | null;
}
