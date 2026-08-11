/**
 * Anthropic streaming event emitter.
 *
 * Maps `AsyncIterable<StreamChunk>` → `AsyncIterable<string>` of SSE frames
 * (`event: <t>\ndata: <json>\n\n`).
 *
 * State machine re-keyed on `delta.content` / `delta.reasoning_content`
 * (NOT phase). Details-strip on text deltas only (never reasoning_content).
 *
 * D7 MVP: thinking-block signatures are empty strings (only when thinking emitted).
 * D14: sentinel `{done:true, extra:{rateLimited:true}}` → terminal error event.
 */

import { randomUUID } from "node:crypto";
import type { StreamChunk } from "../../pool/retry";
import type { OpenAiChatChunk } from "../../upstream/client";
import { DetailsStreamStripper } from "../../upstream/details-strip";

export interface StreamAnthropicEventsOpts {
  model: string;
  inputTokens: number;
  /** Injectable setInterval for testing (default: global setInterval). */
  setIntervalFn?: typeof setInterval;
  /** Injectable clearInterval for testing (default: global clearInterval). */
  clearIntervalFn?: typeof clearInterval;
  /** Injectable Date.now for testing. */
  nowFn?: () => number;
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert a StreamChunk stream into Anthropic SSE event frames.
 */
export async function* streamAnthropicEvents(
  stream: AsyncIterable<StreamChunk>,
  opts: StreamAnthropicEventsOpts,
): AsyncIterable<string> {
  const _setInterval = opts.setIntervalFn ?? setInterval;
  const _clearInterval = opts.clearIntervalFn ?? clearInterval;

  const msgId = `msg_${randomUUID()}`;
  let currentPhase: "think" | "text" | null = null;
  let currentIndex = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;
  const stripper = new DetailsStreamStripper();

  // ── message_start ──────────────────────────────────────────────────────

  yield sse("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: opts.inputTokens, output_tokens: 0 },
    },
  });

  // ── 30 s ping timer ────────────────────────────────────────────────────

  let pingResolve: (() => void) | null = null;
  let pingDue = false;

  const timer = _setInterval(() => {
    pingDue = true;
    if (pingResolve) {
      pingResolve();
      pingResolve = null;
    }
  }, 30_000);

  try {
    const iter = stream[Symbol.asyncIterator]();
    let iterDone = false;
    let pendingNext: Promise<IteratorResult<StreamChunk>> | null = null;

    while (!iterDone) {
      // Yield any pending ping before reading next chunk
      if (pingDue) {
        pingDue = false;
        yield sse("ping", { type: "ping" });
      }

      if (!pendingNext) pendingNext = iter.next();

      const result = await Promise.race([
        pendingNext.then((r) => ({ kind: "chunk" as const, value: r })),
        new Promise<{ kind: "ping" }>((resolve) => {
          pingResolve = () => resolve({ kind: "ping" });
        }),
      ]);

      if (result.kind === "ping") {
        continue;
      }

      const { value: rawChunk, done } = result.value;
      pendingNext = null;
      if (done) {
        iterDone = true;
        break;
      }

      // Narrow to the sentinel shape ("done" in chunk, but not a real OpenAiChatChunk which always has "choices")
      const isSentinel = ("done" in rawChunk) && !("choices" in rawChunk);
      if (isSentinel) {
        const sentinel = rawChunk as { done: true; extra?: { rateLimited?: boolean } };
        if (sentinel.extra?.rateLimited) {
          // D14: terminal error event
          yield sse("error", {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "rate limit exceeded",
            },
          });
          return;
        }
        // Bare {done:true} — clean break
        iterDone = true;
        break;
      }

      // ── Process OpenAiChatChunk ────────────────────────────────────────

      const chunk = rawChunk as OpenAiChatChunk;
      const delta = chunk.choices?.[0]?.delta ?? {};
      const chunkFinishReason = chunk.choices?.[0]?.finish_reason;
      const usage = chunk.usage;

      // Track finishReason / usage
      if (chunkFinishReason) finishReason = chunkFinishReason;
      if (usage?.completion_tokens) {
        outputTokens = usage.completion_tokens;
      }

      // ── First reasoning_content → start thinking block ─────────────────

      if (delta.reasoning_content !== undefined && currentPhase !== "think") {
        if (currentPhase === null) {
          yield sse("content_block_start", {
            type: "content_block_start",
            index: currentIndex,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
        }
        currentPhase = "think";
      }

      // ── First content while think → transition to text ─────────────────

      if (delta.content !== undefined && currentPhase === "think") {
        // Close thinking block with signature_delta + stop
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: currentIndex,
          delta: { type: "signature_delta", signature: "" },
        });
        yield sse("content_block_stop", {
          type: "content_block_stop",
          index: currentIndex,
        });
        currentIndex++;
        // Open text block
        yield sse("content_block_start", {
          type: "content_block_start",
          index: currentIndex,
          content_block: { type: "text", text: "" },
        });
        currentPhase = "text";
      }

      // ── First content while null → start text block at 0 ───────────────

      if (delta.content !== undefined && currentPhase === null) {
        yield sse("content_block_start", {
          type: "content_block_start",
          index: currentIndex,
          content_block: { type: "text", text: "" },
        });
        currentPhase = "text";
      }

      // ── Thinking delta ─────────────────────────────────────────────────

      if (delta.reasoning_content !== undefined && currentPhase === "think") {
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: currentIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      }

      // ── Text delta (via DetailsStreamStripper) ─────────────────────────

      if (delta.content !== undefined && currentPhase === "text") {
        const out = stripper.push(delta.content);
        if (out) {
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: currentIndex,
            delta: { type: "text_delta", text: out },
          });
        }
      }
    }

    // ── Terminal events ───────────────────────────────────────────────────

    // Flush any remaining buffer from the stripper
    const tail = stripper.finalize();
    if (tail && currentPhase === "text") {
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: currentIndex,
        delta: { type: "text_delta", text: tail },
      });
    }

    // Close the last content block if one was opened
    if (currentPhase === "think") {
      // Still in thinking phase at stream end: emit terminal signature + stop (D7 opt-in)
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: currentIndex,
        delta: { type: "signature_delta", signature: "" },
      });
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: currentIndex,
      });
    } else if (currentPhase !== null) {
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: currentIndex,
      });
    }

    yield sse("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapFinishReason(finishReason),
        stop_sequence: null,
      },
      usage: { output_tokens: outputTokens },
    });

    yield sse("message_stop", { type: "message_stop" });
  } finally {
    _clearInterval(timer);
  }
}
