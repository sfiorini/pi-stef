import type { OpenAiChatChunk } from "../upstream/client";
import { RateLimitError, AuthExpiredError } from "../upstream/errors";
import type { AuthScheduler } from "../upstream/auth";
import type { PoolLike } from "./types";
import { PoolExhaustedError } from "./errors";
import type { RequestThrottle } from "./throttle";

export interface RetryDeps {
  pool: PoolLike;
  scheduler: Pick<AuthScheduler, "refreshOnDemand">;
  config: { rateLimitCooldownMs: number; emptyCooldownMs: number };
  /** Per-account request pacer ("look human"). Optional — absent in tests. */
  throttle?: RequestThrottle;
  log: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

/** The union of raw upstream chunks and the one synthetic sentinel chunk. */
export type StreamChunk =
  | OpenAiChatChunk
  | { done: true; extra?: { rateLimited?: boolean } };

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
    await deps.throttle?.waitFor(id);

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
          continue;
        }
        throw new PoolExhaustedError(deps.pool.earliestReEnableAt());
      }

      if (err instanceof AuthExpiredError) {
        if (authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          continue;
        }
        throw err;
      }

      throw err;
    }
  }
}

/**
 * Stream retry with PRE/POST first-content-token split.
 *
 * PRE-first-content-token:
 *   - Buffer control chunks (no content / no reasoning_content).
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
  op: (accountId: number, bearer: string) => AsyncIterable<OpenAiChatChunk>,
): AsyncIterable<StreamChunk> {
  const tried = new Set<number>();
  let authRefreshedFor: number | null = null;

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;
    await deps.throttle?.waitFor(id);

    const buffer: StreamChunk[] = [];
    let seenContent = false;
    let seenPayload = false;
    let emptyCompletion = false;

    try {
      const iter = op(id, bearer);
      for await (const chunk of iter) {
        if (!seenPayload && hasPayload(chunk)) seenPayload = true;
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

      // Empty completion — qwen.aikit.club masks Baxia CAPTCHA flags as empty
      // 200s (delta:{} + finish_reason:stop, usage:{}). Retrying is pointless
      // (the account is blocked until the CAPTCHA clears) and hammering it is
      // suspicious. Flag it; the handler below the catch applies a SHORT
      // cooldown + failover (not the 24h real-rate-limit cooldown) so accounts
      // cycle back as they recover.
      if (!seenPayload) {
        emptyCompletion = true;
      } else {
        // Clean end — flush remaining buffer
        yield* buffer;
        return;
      }
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
            continue;
          }
          throw new PoolExhaustedError(deps.pool.earliestReEnableAt());
        } else {
          // Post-first-token: background switch + D14 sentinel + terminate
          deps.pool
            .markRateLimitedAndSwitch(id, deps.config.rateLimitCooldownMs)
            .catch(() => {
              deps.log.error(
                "background switch failed after mid-stream rate limit",
              );
            });
          yield { done: true, extra: { rateLimited: true } };
          return;
        }
      }

      if (err instanceof AuthExpiredError) {
        if (!seenContent && authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          continue;
        }
        throw err;
      }

      // All other errors surface
      throw err;
    }

    // Empty completion (reached only if the stream had no payload) — apply the
    // SHORT emptyCooldownMs + failover. Outside the try so the catch (which
    // uses the 24h rateLimitCooldownMs) doesn't re-handle it.
    if (emptyCompletion) {
      deps.log.warn("upstream returned empty completion — short cooldown + failover (likely Baxia CAPTCHA flag)", { accountId: id, cooldownMs: deps.config.emptyCooldownMs });
      tried.add(id);
      const result = await deps.pool.markRateLimitedAndSwitch(
        id,
        deps.config.emptyCooldownMs,
      );
      if (result.newActiveId !== null && !tried.has(result.newActiveId)) {
        continue;
      }
      throw new RateLimitError(
        "upstream returned an empty completion (account likely CAPTCHA-flagged by Baxia anti-bot)",
        { status: 429, retryAfterMs: deps.config.emptyCooldownMs },
      );
    }
  }
}

/**
 * A chunk carries real content if it has delta.content or delta.reasoning_content.
 * Use `("done" in chunk) && !("choices" in chunk)` to narrow to the sentinel
 * before accessing `extra`. A real OpenAiChatChunk always has `choices`.
 */
export function isContentChunk(chunk: OpenAiChatChunk): boolean {
  return Boolean(
    chunk.choices?.[0]?.delta?.content ||
      chunk.choices?.[0]?.delta?.reasoning_content,
  );
}

/** A chunk carries a substantive payload if it has content, reasoning, or tool_calls. */
function hasPayload(chunk: OpenAiChatChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  return Boolean(
    delta && (delta.content || delta.reasoning_content || delta.tool_calls),
  );
}
