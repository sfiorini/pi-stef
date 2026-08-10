import type { QwenChunk } from "../upstream/client";
import { RateLimitError, AuthExpiredError } from "../upstream/errors";
import type { AuthScheduler } from "../upstream/auth";
import type { AccountPool } from "./state";
import { PoolExhaustedError } from "./errors";

export interface RetryDeps {
  pool: AccountPool;
  scheduler: Pick<AuthScheduler, "refreshOnDemand">;
  config: { rateLimitCooldownMs: number };
  log: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

/**
 * Non-stream retry: RateLimitError → switch account → retry; AuthExpiredError → refresh → retry same.
 * Cycle guard: each account tried at most once per call (prevents infinite loop).
 */
export async function withPoolRetry<T>(
  deps: RetryDeps,
  op: (accountId: number, bearer: string) => Promise<T>,
): Promise<T> {
  const tried = new Set<number>();
  let authRefreshedFor: number | null = null;

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;

    try {
      return await op(id, bearer);
    } catch (err) {
      if (err instanceof RateLimitError) {
        tried.add(id);
        const result = await deps.pool.markRateLimitedAndSwitch(
          id,
          deps.config.rateLimitCooldownMs,
        );
        if (result.newActiveId !== null && !tried.has(result.newActiveId)) {
          // Retry with new account
          continue;
        }
        // Exhausted or all accounts tried
        throw new PoolExhaustedError(deps.pool.earliestReEnableAt());
      }

      if (err instanceof AuthExpiredError) {
        if (authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          // Retry on same account (don't add to tried — it's a refresh, not a switch)
          continue;
        }
        // Already refreshed this account — surface the error
        throw err;
      }

      // All other errors surface immediately
      throw err;
    }
  }
}

/**
 * Stream retry with PRE/POST first-content-token split.
 *
 * PRE-first-content-token:
 *   - Buffer control chunks (no phase:"answer" / no content).
 *   - RateLimitError → switch + re-invoke + discard buffer.
 *   - AuthExpiredError → refresh + retry same.
 *
 * POST-first-content-token:
 *   - Yield live.
 *   - RateLimitError → background switch + yield D14 sentinel + terminate.
 *
 * Clean end → flush buffer + return.
 */
export async function* withPoolRetryStream(
  deps: RetryDeps,
  op: (accountId: number, bearer: string) => AsyncIterable<QwenChunk>,
): AsyncIterable<QwenChunk> {
  const tried = new Set<number>();
  let authRefreshedFor: number | null = null;

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;

    const buffer: QwenChunk[] = [];
    let seenContent = false;

    try {
      const iter = op(id, bearer);
      for await (const chunk of iter) {
        if (!seenContent && isContentChunk(chunk)) {
          // First content token — flush buffer first, then yield this chunk
          seenContent = true;
          yield* buffer;
          buffer.length = 0;
          yield chunk;
        } else if (seenContent) {
          // Post-first-content: yield live
          yield chunk;
        } else {
          // Pre-first-content: buffer control chunks
          buffer.push(chunk);
        }
      }

      // Clean end — flush remaining buffer
      yield* buffer;
      return;
    } catch (err) {
      if (err instanceof RateLimitError) {
        if (!seenContent) {
          // Pre-first-token: switch + re-invoke, discard buffer
          tried.add(id);
          const result = await deps.pool.markRateLimitedAndSwitch(
            id,
            deps.config.rateLimitCooldownMs,
          );
          if (result.newActiveId !== null && !tried.has(result.newActiveId)) {
            continue; // retry with new account
          }
          throw new PoolExhaustedError(deps.pool.earliestReEnableAt());
        } else {
          // Post-first-token: background switch + D14 sentinel + terminate
          deps.pool
            .markRateLimitedAndSwitch(id, deps.config.rateLimitCooldownMs)
            .catch(() => {
              deps.log.error("background switch failed after mid-stream rate limit");
            });
          yield { done: true, extra: { rateLimited: true } };
          return;
        }
      }

      if (err instanceof AuthExpiredError) {
        if (!seenContent && authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          continue; // retry same account
        }
        throw err;
      }

      // All other errors surface
      throw err;
    }
  }
}

/** A chunk carries real content if it has phase:"answer" or a non-empty content string. */
function isContentChunk(chunk: QwenChunk): boolean {
  if (chunk.phase === "answer") return true;
  if (chunk.content && chunk.content.length > 0) return true;
  return false;
}
