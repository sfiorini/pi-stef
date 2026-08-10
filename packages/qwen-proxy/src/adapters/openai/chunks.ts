/**
 * OpenAI streaming chunk mappers.
 *
 * firstChunk:   the initial SSE chunk with delta.role = "assistant"
 * mapOpenAiChunk: map a raw OpenAiChatChunk to a framed chat.completion.chunk
 * TERMINATOR:   the SSE "[DONE]" sentinel
 */

import type { OpenAiChatChunk } from "../../upstream/client";

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
 * Map a raw OpenAiChatChunk to a framed chat.completion.chunk envelope.
 *
 * Extracts the first choice's delta and finish_reason, wrapping in the
 * standard OpenAI streaming chunk structure. Usage is passed through
 * when present.
 */
export function mapOpenAiChunk(
  chunk: OpenAiChatChunk,
  id: string,
  created: number,
  model: string,
): Record<string, unknown> {
  const choice = chunk.choices?.[0];

  const entry: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: choice?.index ?? 0,
        delta: choice?.delta ?? {},
        logprobs: null,
        finish_reason: choice?.finish_reason ?? null,
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
