/**
 * Qwen SSE → OpenAI Chat Chunk translator.
 * Layers on parseSseStream (upstream/sse.ts) and maps Qwen-specific
 * delta fields (reasoning_content, thinking_summary, phase, usage)
 * to OpenAI-compatible chunks.
 *
 * CRITICAL: never sets finish_reason — the adapter synthesizes it.
 */

import { parseSseStream } from "./sse";
import type { OpenAiChatChunk } from "./types";
import { ClientError } from "./errors";

/**
 * Map a Qwen upstream delta to a partial OpenAI delta.
 * Returns null if the delta is effectively empty (no role, content, or reasoning).
 *
 * - role is copied only if "assistant" (other roles are stripped)
 * - content is copied as-is
 * - reasoning_content is extracted via extractReasoningContentFromDelta
 */
export function mapUpstreamDeltaToOpenAI(
  delta: any,
): { role?: string; content?: string; reasoning_content?: string } | null {
  if (!delta || typeof delta !== "object") return null;

  const result: { role?: string; content?: string; reasoning_content?: string } = {};

  // Only copy role if it's "assistant"
  if (delta.role === "assistant") {
    result.role = "assistant";
  }

  if (typeof delta.content === "string") {
    result.content = delta.content;
  }

  const reasoning = extractReasoningContentFromDelta(delta);
  if (reasoning) {
    result.reasoning_content = reasoning;
  }

  // Return null if nothing meaningful
  if (!result.role && result.content === undefined && !result.reasoning_content) {
    return null;
  }

  return result;
}

/**
 * Extract reasoning content from a Qwen upstream delta.
 *
 * P1: delta.reasoning_content || delta.reasoning (trimmed, non-empty)
 * P2: if delta.phase === "thinking_summary" → join extra.summary_thought.content[]
 *     normalizing string/object items via .text || .content || .value
 */
export function extractReasoningContentFromDelta(delta: any): string {
  if (!delta || typeof delta !== "object") return "";

  // P2: thinking_summary phase — join summary_thought.content array
  if (delta.phase === "thinking_summary" && delta.extra?.summary_thought?.content) {
    const items = delta.extra.summary_thought.content;
    if (Array.isArray(items)) {
      const joined = items
        .map((item: any) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null) {
            return item.text || item.content || item.value || "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }

  // P1: direct reasoning fields
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim()) {
    return delta.reasoning_content.trim();
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.trim()) {
    return delta.reasoning.trim();
  }

  return "";
}

/**
 * Map Qwen usage object to OpenAI-compatible usage.
 *
 * - input_tokens → prompt_tokens
 * - output_tokens → completion_tokens
 * - total_tokens = usage.total_tokens || (prompt + completion)
 * - Copies input_tokens_details → prompt_tokens_details
 * - Copies output_tokens_details → completion_tokens_details
 */
export function mapUsageToOpenAI(usage: any): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: unknown;
  completion_tokens_details?: unknown;
} {
  const prompt = +(usage?.input_tokens) || 0;
  const completion = +(usage?.output_tokens) || 0;
  const total = +(usage?.total_tokens) || (prompt + completion);

  const result: any = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };

  if (usage?.input_tokens_details) {
    result.prompt_tokens_details = usage.input_tokens_details;
  }
  if (usage?.output_tokens_details) {
    result.completion_tokens_details = usage.output_tokens_details;
  }

  return result;
}

/**
 * Extract image URLs from upstream SSE delta (phase === "image_gen").
 * Best-effort; returns [] if no images present.
 * (Dead-ish post-media-rip but spec-required.)
 */
export function extractImageUrlsFromUpstreamSse(delta: any): string[] {
  if (!delta || delta.phase !== "image_gen") return [];
  // Best-effort extraction
  const urls: string[] = [];
  if (Array.isArray(delta.extra?.images)) {
    for (const img of delta.extra.images) {
      if (typeof img === "string") urls.push(img);
      else if (img?.url) urls.push(img.url);
    }
  }
  return urls;
}

/**
 * Check if a parsed SSE payload indicates data_inspection_failed.
 * True if payload.data_inspection_failed === true.
 */
export function isDataInspectionFailed(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  return payload.data_inspection_failed === true;
}

/**
 * Translate a Qwen SSE stream into OpenAI-compatible ChatChunks.
 * Layers on parseSseStream; maps each event through the helpers above.
 *
 * CRITICAL: never sets finish_reason — the adapter synthesizes it.
 * On data_inspection_failed → throws ClientError (content moderation, not a rate limit).
 */
export async function* translateQwenSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiChatChunk> {
  for await (const ev of parseSseStream(body)) {
    if (ev.data === "[DONE]") return;

    let json: any;
    try {
      json = JSON.parse(ev.data);
    } catch {
      // Skip non-JSON data lines
      continue;
    }

    if (isDataInspectionFailed(json)) {
      throw new ClientError("data_inspection_failed: content moderated by upstream", { status: 400 });
    }

    const upDelta = json?.choices?.[0]?.delta;
    const delta = mapUpstreamDeltaToOpenAI(upDelta);
    const usage = json?.usage ? mapUsageToOpenAI(json.usage) : undefined;

    if (!delta && !usage) continue;

    yield {
      choices: [
        {
          index: 0,
          ...(delta ? { delta } : { delta: {} }),
        },
      ],
      ...(usage ? { usage } : {}),
    } as OpenAiChatChunk;
  }
}
