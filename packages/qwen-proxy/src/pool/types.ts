/**
 * Minimal pool interface consumed by retry.ts.
 *
 * SingleAccountPool (guest shim) satisfies this interface. Retry logic
 * depends on these 4 methods.  markEmptyAndSwitch applies a flat short
 * cooldown after inline-retry exhaustion on empty completions.
 */
export interface PoolLike {
  getActiveAccount(): { id: number; bearer: string; expiresAt: number | null };
  /** Empty completion (Baxia CAPTCHA flag, AFTER inline-retry exhaustion): flat short cooldown. */
  markEmptyAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  /** Healthy completion. No-op in guest mode (retained for PoolLike). */
  markSuccess(): void;
  earliestReEnableAt(): number | null;
}
