/**
 * Minimal pool interface consumed by retry.ts.
 *
 * Both AccountPool (legacy multi-account) and SingleAccountPool (guest shim)
 * satisfy this interface. Retry logic depends only on these 3 methods.
 */
export interface PoolLike {
  getActiveAccount(): { id: number; bearer: string; expiresAt: number | null };
  markRateLimitedAndSwitch(
    failedId: number,
    cooldownMs: number,
  ): Promise<{ newActiveId: number | null; earliestReEnableAt: number | null }>;
  earliestReEnableAt(): number | null;
}
