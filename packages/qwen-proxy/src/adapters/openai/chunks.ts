/**
 * OpenAI streaming chunk mappers.
 *
 * firstChunk: the initial SSE chunk with delta.role = "assistant"
 * mapChunk:   map a QwenChunk to an OpenAI delta chunk
 * TERMINATOR: the SSE "[DONE]" sentinel
 */

import type { QwenChunk } from "../../upstream/client";

/** Initial chunk that sets delta.role = "assistant". */
export function firstChunk(id: string, created: number, model: string) {
  return {
    id,
    object: "chat.completion.chunk" as const,
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" as const },
        logprobs: null,
        finish_reason: null,
      },
    ],
  };
}

/**
 * Map a QwenChunk to an OpenAI streaming delta line.
 *
 * - phase:"think" → delta.reasoning_content
 * - phase:"answer" or phase-less with content → delta.content
 * - finishReason → finish_reason
 * - usage passthrough
 *
 * Returns null for chunks with neither phase nor content (skip).
 */
export function mapChunk(chunk: QwenChunk): Record<string, unknown> | null {
  // Skip chunks with neither phase nor content
  if (!chunk.phase && !chunk.content) return null;

  const delta: Record<string, unknown> = {};

  if (chunk.phase === "think") {
    delta.reasoning_content = chunk.content ?? "";
  } else {
    // phase: "answer" or undefined (content-carrying)
    delta.content = chunk.content ?? "";
  }

  const entry: Record<string, unknown> = {
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: chunk.finishReason ?? null,
      },
    ],
  };

  if (chunk.usage) {
    entry.usage = chunk.usage;
  }

  return entry;
}

/** SSE terminator — emitted after the final chunk. */
export const TERMINATOR = "data: [DONE]\n\n";
