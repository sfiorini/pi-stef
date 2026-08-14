/**
 * Shared stream stall guard (change #3, Q4/Q6).
 *
 * Wraps the translated OpenAI chunk stream (the output of translateQwenSse) for
 * BOTH stream and non-stream completions, holding the raw body handle so a
 * stalled upstream can always be torn down:
 *
 * - First-payload timer (SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS, default 30s, 0=off):
 *   armed at guard start, disarmed on the first chunk carrying payload
 *   (content / reasoning_content / tool_calls). A usage-only chunk does NOT
 *   disarm it. On fire: cancel the body and throw EmptyCompletionError — the
 *   retry layer treats that as a rotation trigger, and the guest-client finally
 *   releases the semaphore slot. Covers "SSE 200 then silence forever".
 *
 * - Idle timer (SF_QWEN_STREAM_IDLE_TIMEOUT_MS, default 30s, 0=off): armed only
 *   after the first payload chunk, reset on every chunk. On fire: cancel the
 *   body and END GRACEFULLY — the client keeps the partial content, no
 *   rateLimited sentinel, no token eviction (Q6). In non-stream mode the
 *   partially-buffered completion is returned as-is.
 *
 * The two deadlines never race: before the first payload only the first-payload
 * timer runs; after it only the idle timer runs.
 */

import { EmptyCompletionError } from "./errors";
import type { OpenAiChatChunk } from "./types";

export interface StallGuardOpts {
  /** ms without a payload chunk after guard start → EmptyCompletionError. 0 disables. */
  firstPayloadTimeoutMs?: number;
  /** ms without any chunk after content started → graceful end. 0 disables. */
  idleTimeoutMs?: number;
}

/** A chunk carries substantive payload if it has content, reasoning, or tool_calls. */
function chunkHasPayload(chunk: OpenAiChatChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  return Boolean(delta && (delta.content || delta.reasoning_content || delta.tool_calls));
}

export async function* withStallGuard(
  chunks: AsyncIterable<OpenAiChatChunk>,
  body: ReadableStream<Uint8Array> | undefined,
  opts: StallGuardOpts = {},
): AsyncGenerator<OpenAiChatChunk> {
  const firstMs = opts.firstPayloadTimeoutMs ?? 30_000;
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  const iterator = chunks[Symbol.asyncIterator]();

  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sawPayload = false;
  let fired: "first" | "idle" | undefined;
  let resolveFired: () => void = () => {};
  const firedPromise = new Promise<void>((resolve) => {
    resolveFired = resolve;
  });

  const fire = (kind: "first" | "idle"): void => {
    if (fired) return;
    fired = kind;
    void body?.cancel().catch(() => {});
    resolveFired();
  };

  if (firstMs > 0) firstTimer = setTimeout(() => fire("first"), firstMs);

  const armIdle = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire("idle"), idleMs);
  };

  try {
    while (true) {
      // Race the pending read against the timers — a stalled upstream read
      // never resolves, so a bare await would hang past the deadline.
      const next = await Promise.race([iterator.next(), firedPromise]);
      if (next === undefined || fired) break; // timer fired (or fired mid-yield)
      if (next.done) break;
      const chunk = next.value;
      if (!sawPayload && chunkHasPayload(chunk)) {
        sawPayload = true;
        if (firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
        }
      }
      if (sawPayload) armIdle();
      yield chunk;
    }

    if (fired === "first") {
      throw new EmptyCompletionError(
        `first payload timeout: no content within ${firstMs}ms (SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS)`,
      );
    }
    // fired === "idle" or clean exhaustion → graceful end (partial content kept)
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
    void iterator.return?.(undefined).catch(() => {});
    void body?.cancel().catch(() => {});
  }
}
