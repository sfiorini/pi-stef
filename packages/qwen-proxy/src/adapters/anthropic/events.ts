/**
 * Anthropic streaming event emitter.
 *
 * Maps `AsyncIterable<QwenChunk>` → `AsyncIterable<string>` of SSE frames
 * (`event: <t>\ndata: <json>\n\n`).
 *
 * D7 MVP: thinking-block signatures are empty strings (Qwen gives no verifiable signature).
 * D14: sentinel `{done:true, extra:{rateLimited:true}}` → terminal error event.
 */

import { randomUUID } from "node:crypto";
import type { QwenChunk } from "../../upstream/client";

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
 * Convert a QwenChunk stream into Anthropic SSE event frames.
 */
export async function* streamAnthropicEvents(
  qwenStream: AsyncIterable<QwenChunk>,
  opts: StreamAnthropicEventsOpts,
): AsyncIterable<string> {
  const _setInterval = opts.setIntervalFn ?? setInterval;
  const _clearInterval = opts.clearIntervalFn ?? clearInterval;

  const msgId = `msg_${randomUUID()}`;
  let currentPhase: "think" | "answer" | null = null;
  let currentIndex = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;

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
    // Unblock any pending iter.next() so we can yield the ping
    if (pingResolve) {
      pingResolve();
      pingResolve = null;
    }
  }, 30_000);

  try {
    const iter = qwenStream[Symbol.asyncIterator]();
    let iterDone = false;

    while (!iterDone) {
      // Yield any pending ping before reading next chunk
      if (pingDue) {
        pingDue = false;
        yield sse("ping", { type: "ping" });
      }

      // Race between the next chunk and a ping timer firing
      const result = await Promise.race([
        iter.next().then((r) => ({ kind: "chunk" as const, value: r })),
        new Promise<{ kind: "ping" }>((resolve) => {
          pingResolve = () => resolve({ kind: "ping" });
        }),
      ]);

      if (result.kind === "ping") {
        // Ping timer fired; loop back to yield it
        continue;
      }

      const { value: chunk, done } = result.value;
      if (done) {
        iterDone = true;
        break;
      }

      // ── Sentinel (D14) ─────────────────────────────────────────────────

      if (chunk.done && chunk.extra?.rateLimited) {
        yield sse("error", {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "rate limit exceeded",
          },
        });
        return;
      }

      if (chunk.done) {
        iterDone = true;
        break;
      }

      // ── finishReason / usage tracking ───────────────────────────────────

      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage?.completion_tokens) {
        outputTokens = chunk.usage.completion_tokens;
      }

      // ── Phase transitions ──────────────────────────────────────────────

      if (chunk.phase === "think" && currentPhase !== "think") {
        // First think chunk → emit content_block_start for thinking at currentIndex
        if (currentPhase === null) {
          yield sse("content_block_start", {
            type: "content_block_start",
            index: currentIndex,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
        }
        currentPhase = "think";
      }

      if (chunk.phase === "answer" && currentPhase === "think") {
        // Think → answer transition: signature_delta (D7 empty) → stop → start text
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
        // Start text block
        yield sse("content_block_start", {
          type: "content_block_start",
          index: currentIndex,
          content_block: { type: "text", text: "" },
        });
        currentPhase = "answer";
      }

      if (
        chunk.phase === "answer" &&
        currentPhase === null &&
        !chunk.done
      ) {
        // No-think: first content is answer → text block at index 0
        yield sse("content_block_start", {
          type: "content_block_start",
          index: currentIndex,
          content_block: { type: "text", text: "" },
        });
        currentPhase = "answer";
      }

      // ── Content deltas ─────────────────────────────────────────────────

      if (chunk.phase === "think" && chunk.content) {
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: currentIndex,
          delta: { type: "thinking_delta", thinking: chunk.content },
        });
      }

      if (
        (chunk.phase === "answer" || (!chunk.phase && chunk.content)) &&
        chunk.content
      ) {
        // If we haven't started a text block yet (no phase chunks seen)
        if (currentPhase === null) {
          yield sse("content_block_start", {
            type: "content_block_start",
            index: currentIndex,
            content_block: { type: "text", text: "" },
          });
          currentPhase = "answer";
        }
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: currentIndex,
          delta: { type: "text_delta", text: chunk.content },
        });
      }
    }

    // ── Terminal events ───────────────────────────────────────────────────

    // Close the last content block if one was opened
    if (currentPhase === "think") {
      // Still in thinking phase at stream end: emit signature + stop
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
