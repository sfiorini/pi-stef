import type { OpenAiChatChunk } from "../upstream/client";
import { RateLimitError, AuthExpiredError, EmptyCompletionError, NetworkError, ServerError, ClientError, UnknownError } from "../upstream/errors";
import type { PoolLike } from "./types";
import type { RequestThrottle } from "./throttle";

/** Minimal proxy-pool contract for rotation mode (S-M2). */
export interface ProxyPoolLike {
  readonly size: number;
  getActive(): string | undefined;
  rotate(): string | undefined;
}

/** Minimal scheduler contract retry needs: on-demand token refresh. */
export interface RetryScheduler {
  refreshOnDemand(id: number): Promise<{ bearer: string; expiresAt: number | null }>;
  /** Best-effort Baxia token rotation — called on empty-exhaustion so the next request gets a fresh, unflagged token. Optional (absent in tests). */
  refreshBaxiaToken?(): Promise<void>;
}

export interface RetryDeps {
  pool: PoolLike;
  scheduler: RetryScheduler;
  config: { emptyCooldownMs: number; emptyRetryMax: number; emptyRetryGapMs: number };
  /** Per-account request pacer ("look human"). Optional — absent in tests. */
  throttle?: RequestThrottle;
  /** Optional proxy pool for SOCKS5 rotation mode (S-M2). */
  proxyPool?: ProxyPoolLike;
  log: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

/** Module-level sleep helper for inline empty-retry gaps. */
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** The union of raw upstream chunks and the one synthetic sentinel chunk. */
export type StreamChunk =
  | OpenAiChatChunk
  | { done: true; extra?: { rateLimited?: boolean } };

/**
 * Non-stream retry: AuthExpiredError → refresh → retry same.
 * EmptyCompletionError → inline retry (up to emptyRetryMax) → exhaustion sentinel.
 */
export async function withPoolRetry<T>(
  deps: RetryDeps,
  op: (accountId: number, bearer: string, proxy?: string) => Promise<T>,
): Promise<T> {
  let authRefreshedFor: number | null = null;
  let emptyRetries = 0;
  const rotationMode = !!(deps.proxyPool && deps.proxyPool.size > 1);
  let tried = 0;

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;
    await deps.throttle?.waitFor(id);
    const proxy = deps.proxyPool?.getActive();

    try {
      const result = await op(id, bearer, proxy);
      deps.pool.markSuccess();
      return result;
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          continue;
        }
        throw err;
      }

      // Rotation mode: rotate on rotatable errors (pre-first-content budget)
      if (rotationMode && isRotationTrigger(err)) {
        tried++;
        if (tried < deps.proxyPool!.size) {
          deps.proxyPool!.rotate();
          continue;
        }
        // All proxies burned — cooldown + 429
        const { emptyCooldownMs } = deps.config;
        await sleep(emptyCooldownMs);
        throw new RateLimitError(
          "all proxies exhausted after rotation retries",
          { status: 429, retryAfterMs: emptyCooldownMs },
        );
      }

      // Legacy mode (no proxyPool or size≤1): EmptyCompletionError inline-retry
      if (err instanceof EmptyCompletionError) {
        const { emptyRetryMax, emptyRetryGapMs, emptyCooldownMs } = deps.config;
        if (emptyRetries < emptyRetryMax) {
          deps.log.warn("empty completion — inline retry", {
            accountId: id,
            attempt: emptyRetries + 1,
            max: emptyRetryMax,
          });
          await sleep(emptyRetryGapMs);
          emptyRetries++;
          continue;
        }
        // Exhausted — flat cooldown + 429
        deps.log.warn("empty completion retries exhausted — flat cooldown + 429", {
          accountId: id,
          cooldownMs: emptyCooldownMs,
        });
        await deps.pool.markEmptyAndSwitch(id, emptyCooldownMs);
        // Rotate the Baxia token so the next request (after cooldown) gets a fresh,
        // unflagged token — recovers the sustained-token-burn "stuck" state without a restart.
        try { await deps.scheduler.refreshBaxiaToken?.(); }
        catch (e) { deps.log.error("baxia token refresh failed after empty-exhaustion", { error: String(e) }); }
        throw new RateLimitError("upstream returned an empty completion after retries (likely rate-limited, try again later)", { status: 429, retryAfterMs: emptyCooldownMs });
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
 *   - AuthExpiredError → refresh + retry same.
 *
 * POST-first-content-token:
 *   - Yield live.
 *
 * Clean end → flush buffer + return.
 * EmptyCompletion sentinel on exhaustion (up to emptyRetryMax inline retries).
 */
export async function* withPoolRetryStream(
  deps: RetryDeps,
  op: (accountId: number, bearer: string, proxy?: string) => AsyncIterable<OpenAiChatChunk>,
): AsyncIterable<StreamChunk> {
  let authRefreshedFor: number | null = null;
  let emptyRetries = 0;
  const rotationMode = !!(deps.proxyPool && deps.proxyPool.size > 1);
  let tried = 0;

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;
    await deps.throttle?.waitFor(id);
    const proxy = deps.proxyPool?.getActive();

    const buffer: StreamChunk[] = [];
    let seenContent = false;
    let seenPayload = false;
    let emptyCompletion = false;

    try {
      const iter = op(id, bearer, proxy);
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

      // Empty completion — no payload seen. Inline retry up to
      // emptyRetryMax, then apply flat emptyCooldownMs + sentinel.
      if (!seenPayload) {
        emptyCompletion = true;
      } else {
        // Clean end — flush remaining buffer
        deps.pool.markSuccess();
        yield* buffer;
        return;
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (!seenContent && authRefreshedFor !== id) {
          authRefreshedFor = id;
          await deps.scheduler.refreshOnDemand(id);
          continue;
        }
        throw err;
      }

      // Rotation mode: rotate on rotatable errors (PRE-first-content ONLY)
      if (rotationMode && !seenContent && isRotationTrigger(err)) {
        tried++;
        if (tried < deps.proxyPool!.size) {
          deps.proxyPool!.rotate();
          continue;
        }
        // All proxies burned — sentinel (no refreshBaxiaToken)
        deps.log.warn("rotation: all proxies burned (error) — sentinel", { size: deps.proxyPool!.size });
        yield { done: true, extra: { rateLimited: true } };
        return;
      }

      // All other errors surface
      throw err;
    }

    // Rotation mode: empty → rotate (PRE-first-content)
    if (emptyCompletion && rotationMode) {
      tried++;
      if (tried < deps.proxyPool!.size) {
        deps.proxyPool!.rotate();
        continue;
      }
      // All proxies burned — sentinel (no refreshBaxiaToken)
      deps.log.warn("rotation: all proxies burned (empty) — sentinel", { size: deps.proxyPool!.size });
      yield { done: true, extra: { rateLimited: true } };
      return;
    }

    // Inline retry on empty completion — same account, up to emptyRetryMax.
    if (emptyCompletion) {
      const { emptyRetryMax, emptyRetryGapMs, emptyCooldownMs } = deps.config;
      if (emptyRetries < emptyRetryMax) {
        deps.log.warn("empty completion — inline retry", {
          accountId: id,
          attempt: emptyRetries + 1,
          max: emptyRetryMax,
        });
        await sleep(emptyRetryGapMs);
        emptyRetries++;
        continue;
      }
      // Exhausted — fire-and-forget flat cooldown + graceful sentinel
      deps.log.warn("empty completion retries exhausted — flat cooldown + sentinel", {
        accountId: id,
        cooldownMs: emptyCooldownMs,
      });
      deps.pool
        .markEmptyAndSwitch(id, emptyCooldownMs)
        .catch(() => {
          deps.log.error("background markEmptyAndSwitch failed");
        });
      // Rotate the Baxia token so the next request gets a fresh, unflagged token.
      try { await deps.scheduler.refreshBaxiaToken?.(); }
      catch (e) { deps.log.error("baxia token refresh failed after empty-exhaustion", { error: String(e) }); }
      yield { done: true, extra: { rateLimited: true } };
      return;
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

/**
 * Classify whether an error should trigger proxy rotation (vs being terminal).
 *
 * Rotatable (rotate to next proxy):
 *   - EmptyCompletionError (likely Baxia CAPTCHA flag)
 *   - NetworkError (TTFB timeout, connection reset)
 *   - ServerError (5xx upstream failure)
 *   - TypeError (fetch internals failure)
 *   - AbortError (name-based, e.g. undici abort)
 *   - Residual generic Error (e.g. raw SOCKS connect failure)
 *
 * Terminal (do NOT rotate — surface immediately):
 *   - ClientError (4xx, incl data_inspection_failed)
 *   - RateLimitError (429)
 *   - UnknownError
 *
 * Non-Error → false (not rotatable).
 */
export function isRotationTrigger(err: unknown): boolean {
  if (err instanceof EmptyCompletionError) return true;
  if (err instanceof NetworkError) return true;
  if (err instanceof ServerError) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof AuthExpiredError) return false; // token refresh (same proxy) — never a rotation trigger
  if (err instanceof ClientError) return false;
  if (err instanceof RateLimitError) return false;
  if (err instanceof UnknownError) return false;
  if (err instanceof Error) return true; // residual generic Error → rotate
  return false; // non-Error → not rotatable
}
