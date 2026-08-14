import type { OpenAiChatChunk } from "../upstream/client";
import { TokenMintError, RateLimitError, AuthExpiredError, EmptyCompletionError, NetworkError, ServerError, ClientError, UnknownError } from "../upstream/errors";
import { redactProxyKey } from "../upstream/proxy-bridge";
import type { PoolLike } from "./types";
import type { RequestThrottle } from "./throttle";

/** Minimal proxy-pool contract for rotation mode (S-M2 + burn-dynamics Q2=C).
 *  acquire/release are OPTIONAL per-proxy serialization slots: when present the
 *  retry layer holds one slot per request (sticky-first assignment, spread under
 *  concurrency); when absent (legacy fakes / non-slot pools) retry falls back to
 *  sticky getActive() + rotate(). */
export interface ProxyPoolLike {
  readonly size: number;
  getActive(): string | undefined;
  rotate(): string | undefined;
  acquire?(): Promise<string>;
  release?(key: string): void;
}

/** Minimal scheduler contract retry needs: on-demand token refresh. */
export interface RetryScheduler {
  refreshOnDemand(id: number): Promise<{ bearer: string; expiresAt: number | null }>;
  /** Force-refresh a proxy's Baxia token (defaults to the active proxy). Optional (absent in tests). */
  refreshBaxiaToken?(proxy?: string): Promise<void>;
  /** Mark a proxy's Baxia token burned (evict + log requestsServed). Optional (absent in tests). */
  evictBaxiaToken?(proxy?: string): void;
  /** Age of the proxy's cached token in ms (for empty-walk logging). Optional (absent in tests). */
  baxiaTokenAgeMs?(proxy?: string): number | null;
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

/** Per-request consecutive mint-failure budget. */
const MINT_STRIKE_MAX = 2;

/** The union of raw upstream chunks and the one synthetic sentinel chunk. */
export type StreamChunk =
  | OpenAiChatChunk
  | { done: true; extra?: { rateLimited?: boolean } };

/** Best-effort sentinel refresh; never fatal. */
async function bestEffortRefresh(
  deps: RetryDeps,
  proxy: string | undefined,
): Promise<void> {
  try {
    await deps.scheduler.refreshBaxiaToken?.(proxy);
  } catch (e) {
    deps.log.error("baxia token refresh failed after all-burned", { error: String(e), proxy: redactProxyKey(proxy) });
  }
}

/** Slot-aware proxy hand-off on rotation: advance the head, acquire the new
 *  head's slot (sticky-first, skips busy proxies), THEN release the old slot so
 *  the burned proxy is not handed to another request mid-flight. */
async function rotateWithSlot(deps: RetryDeps, current: string | undefined): Promise<string | undefined> {
  const pool = deps.proxyPool!;
  pool.rotate();
  if (typeof pool.acquire === "function" && typeof pool.release === "function") {
    const next = await pool.acquire();
    if (current !== undefined) pool.release(current);
    return next;
  }
  return pool.getActive();
}

/** Rotation-mode empty-completion burn recovery (Q1=B):
 *  1. log the walk attempt (redacted proxy, tried/size, token age)
 *  2. evict the proxy's burned token
 *  3. if no inline re-mint happened yet for this request: force re-mint and
 *     retry the SAME proxy (bounded: one per request)
 *  4. else rotate (or signal all-burned when the walk budget is spent)
 *  Returns the next action: remint (retry same proxy), rotate (next proxy),
 *  or all-burned (sentinel/429 + refresh). */
async function emptyBurnStep(
  deps: RetryDeps,
  opts: { proxy: string | undefined; tried: number; inlineReminted: boolean },
): Promise<{ action: "remint" } | { action: "rotate"; proxy: string | undefined } | { action: "all-burned" }> {
  const pool = deps.proxyPool!;
  deps.log.warn("[rotation-debug] empty completion — walking", {
    proxy: redactProxyKey(opts.proxy),
    tried: opts.tried + 1,
    size: pool.size,
    tokenAgeMs: opts.proxy ? (deps.scheduler.baxiaTokenAgeMs?.(opts.proxy) ?? null) : null,
  });
  if (opts.proxy !== undefined) deps.scheduler.evictBaxiaToken?.(opts.proxy);
  if (!opts.inlineReminted) {
    // Inline re-mint on the SAME proxy (bounded once per request) — the egress
    // IP is usually fine, only the token is burned.
    try {
      await deps.scheduler.refreshBaxiaToken?.(opts.proxy);
    } catch (e) {
      deps.log.error("baxia inline re-mint failed — rotating", { error: String(e), proxy: redactProxyKey(opts.proxy) });
      if (opts.tried < pool.size - 1) {
        return { action: "rotate", proxy: await rotateWithSlot(deps, opts.proxy) };
      }
      return { action: "all-burned" };
    }
    return { action: "remint" };
  }
  if (opts.tried < pool.size - 1) {
    return { action: "rotate", proxy: await rotateWithSlot(deps, opts.proxy) };
  }
  return { action: "all-burned" };
}

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
  const useSlots = !!(deps.proxyPool?.acquire && deps.proxyPool?.release);
  let tried = 0;
  let mintStrikes = 0;
  let inlineReminted = false;
  let slotKey: string | undefined;

  try {
    if (useSlots) slotKey = await deps.proxyPool!.acquire!();

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;
    await deps.throttle?.waitFor(id);
    const proxy = slotKey ?? deps.proxyPool?.getActive();

    try {
      const result = await op(id, bearer, proxy);
      deps.pool.markSuccess();
      mintStrikes = 0;
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

      // Rotation mode: empty completion → burn recovery (evict + inline re-mint, Q1=B)
      if (rotationMode && err instanceof EmptyCompletionError) {
        const allowRemint = !inlineReminted;
        const step = await emptyBurnStep(deps, { proxy, tried, inlineReminted });
        if (allowRemint) inlineReminted = true; // an ATTEMPT consumes the one-per-request allowance
        if (step.action === "remint") {
          continue; // retry the SAME proxy with the fresh token
        }
        if (step.action === "rotate") {
          tried += 1;
          slotKey = useSlots ? step.proxy : undefined;
          continue;
        }
        // All proxies burned — cooldown + refresh active token (change #2, Q3=A) + 429
        tried += 1;
        const { emptyCooldownMs } = deps.config;
        deps.log.warn("[rotation-debug] ALL burned (non-stream)", { size: deps.proxyPool!.size, lastError: String(err).slice(0, 300) });
        await sleep(emptyCooldownMs);
        await bestEffortRefresh(deps, proxy);
        throw new RateLimitError(
          "all proxies exhausted after rotation retries",
          { status: 429, retryAfterMs: emptyCooldownMs },
        );
      }

      // Rotation mode: rotate on rotatable errors (pre-first-content budget)
      if (rotationMode && isRotationTrigger(err)) {
        tried++;
        deps.log.warn("[rotation-debug] attempt failed — rotating", {
          proxy: redactProxyKey(proxy),
          tried,
          size: deps.proxyPool!.size,
          error: String(err).slice(0, 300),
          errorCause: err instanceof Error && err.cause ? String(err.cause).slice(0, 300) : undefined,
          errorName: err instanceof Error ? err.constructor.name : typeof err,
          ...(err instanceof TokenMintError ? { mintCause: err.cause, mintStrikes } : {}),
        });
        if (err instanceof TokenMintError) {
          mintStrikes++;
          if (mintStrikes >= MINT_STRIKE_MAX) {
            deps.log.warn("mint failures exhausted — flat cooldown + 429", { strikes: mintStrikes, size: deps.proxyPool!.size });
            await deps.pool.markEmptyAndSwitch(id, deps.config.emptyCooldownMs);
            await sleep(deps.config.emptyCooldownMs);
            throw new RateLimitError(
              "token mint failed after 2 consecutive attempts (global egress condition) — cooling down",
              { status: 429, retryAfterMs: deps.config.emptyCooldownMs },
            );
          }
        }
        if (tried < deps.proxyPool!.size) {
          const next = await rotateWithSlot(deps, slotKey ?? proxy);
          slotKey = useSlots ? next : undefined;
          continue;
        }
        // All proxies burned — cooldown + refresh active token (change #2) + 429
        const { emptyCooldownMs } = deps.config;
        deps.log.warn("[rotation-debug] ALL burned (non-stream)", { size: deps.proxyPool!.size, lastError: String(err).slice(0, 300) });
        await sleep(emptyCooldownMs);
        await bestEffortRefresh(deps, proxy);
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
  } finally {
    // Release the per-proxy serialization slot on EVERY exit path (success,
    // throw, all-burned) — the request owned exactly one slot.
    if (slotKey !== undefined && useSlots) deps.proxyPool!.release!(slotKey);
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
  const useSlots = !!(deps.proxyPool?.acquire && deps.proxyPool?.release);
  let tried = 0;
  let inlineReminted = false;
  let slotKey: string | undefined;

  try {
    if (useSlots) slotKey = await deps.proxyPool!.acquire!();

  while (true) {
    const acct = deps.pool.getActiveAccount();
    const { id, bearer } = acct;
    await deps.throttle?.waitFor(id);
    const proxy = slotKey ?? deps.proxyPool?.getActive();

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

      // Rotation mode: THROWN EmptyCompletionError pre-first-content (stall-guard
      // first-payload timeout) → burn recovery (evict + inline re-mint), NOT plain
      // rotation — otherwise the burned token stays cached (impl-review F1).
      if (rotationMode && !seenContent && err instanceof EmptyCompletionError) {
        const allowRemint = !inlineReminted;
        const step = await emptyBurnStep(deps, { proxy, tried, inlineReminted });
        if (allowRemint) inlineReminted = true; // an ATTEMPT consumes the one-per-request allowance
        if (step.action === "remint") {
          continue; // retry the SAME proxy with the fresh token
        }
        if (step.action === "rotate") {
          tried += 1;
          slotKey = useSlots ? step.proxy : undefined;
          continue;
        }
        tried += 1;
        deps.log.warn("rotation: all proxies burned (empty) — sentinel", { size: deps.proxyPool!.size });
        await bestEffortRefresh(deps, proxy);
        yield { done: true, extra: { rateLimited: true } };
        return;
      }

      // Rotation mode: rotate on rotatable errors (PRE-first-content ONLY)
      if (rotationMode && !seenContent && isRotationTrigger(err)) {
        tried++;
        deps.log.warn("[rotation-debug] stream attempt failed — rotating", {
          proxy: redactProxyKey(proxy),
          tried,
          size: deps.proxyPool!.size,
          error: String(err).slice(0, 300),
          errorCause: err instanceof Error && err.cause ? String(err.cause).slice(0, 300) : undefined,
          errorName: err instanceof Error ? err.constructor.name : typeof err,
        });
        if (tried < deps.proxyPool!.size) {
          const next = await rotateWithSlot(deps, slotKey ?? proxy);
          slotKey = useSlots ? next : undefined;
          continue;
        }
        // All proxies burned — refresh the active proxy's token (change #2, Q3=A), then sentinel
        deps.log.warn("rotation: all proxies burned (error) — sentinel", { size: deps.proxyPool!.size, lastError: String(err).slice(0, 300) });
        await bestEffortRefresh(deps, proxy);
        yield { done: true, extra: { rateLimited: true } };
        return;
      }

      // All other errors surface
      throw err;
    }

    // Rotation mode: empty → burn recovery (evict + inline re-mint once → rotate → sentinel)
    if (emptyCompletion && rotationMode) {
      const allowRemint = !inlineReminted;
      const step = await emptyBurnStep(deps, { proxy, tried, inlineReminted });
      if (allowRemint) inlineReminted = true; // an ATTEMPT consumes the one-per-request allowance
      if (step.action === "remint") {
        continue; // retry the SAME proxy with the fresh token
      }
      if (step.action === "rotate") {
        tried += 1;
        slotKey = useSlots ? step.proxy : undefined;
        continue;
      }
      // All proxies burned — refresh the active proxy's token, then sentinel (change #2, Q3=A)
      tried += 1;
      deps.log.warn("rotation: all proxies burned (empty) — sentinel", { size: deps.proxyPool!.size });
      await bestEffortRefresh(deps, proxy);
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
  } finally {
    // Release the per-proxy serialization slot on EVERY exit path (clean end,
    // sentinel, throw, consumer break — the generator's return() lands here).
    if (slotKey !== undefined && useSlots) deps.proxyPool!.release!(slotKey);
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
  if (err instanceof TokenMintError) return true; // rotatable (single bad proxy skipped) — but budgeted ≤2/request by the wrappers
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
