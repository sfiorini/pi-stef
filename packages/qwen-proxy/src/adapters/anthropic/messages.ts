/**
 * POST /v1/messages — Anthropic-compatible chat endpoint.
 *
 * Supports both stream and non-stream modes.
 * Resolves model aliases + claude-* → qwen3-max fallback.
 * Pool exhausted → 429 rate_limit_error.
 * Sentinel mid-stream → error event (D14).
 *
 * D7 MVP: thinking-block signatures are empty strings (Qwen gives no verifiable signature).
 */

import { randomUUID } from "node:crypto";
import type { UpstreamClient, QwenChunk } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn, withPoolRetryStream as WithPoolRetryStreamFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { parseModelAliases } from "../../config/model-aliases";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { anthropicError } from "./errors";
import { streamAnthropicEvents } from "./events";

export interface AnthropicRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "createChat" | "chatCompletionsStream">;
  retry: typeof WithPoolRetryFn;
  retryStream: typeof WithPoolRetryStreamFn;
  config: RetryDeps["config"] & { modelAliasesRaw: string };
}

/** Resolve Anthropic model ID to Qwen upstream ID. */
function resolveAnthropicModel(
  input: string,
  aliases: Map<string, string>,
): string | null {
  // 1. Check alias map first
  const aliasTarget = aliases.get(input);
  if (aliasTarget) return aliasTarget;

  // 2. Qwen IDs pass through
  if (input.startsWith("qwen")) return input;

  // 3. claude-* → hardcoded flagship qwen3-max
  if (input.startsWith("claude-")) return "qwen3-max";

  // 4. Unknown → 400
  return null;
}

/** Flatten content to string (string OR [{type:"text",text}]). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: unknown) => {
        const part = p as Record<string, unknown>;
        return part && part.type === "text" && typeof part.text === "string";
      })
      .map((p: unknown) => (p as { text: string }).text)
      .join("");
  }
  return "";
}

/** Map upstream finishReason to Anthropic stop_reason. */
function mapStopReason(reason: string | undefined): string {
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

/**
 * Build an Anthropic message response from accumulated QwenChunks (non-stream).
 */
export function buildAnthropicMessage(
  model: string,
  chunks: QwenChunk[],
): Record<string, unknown> {
  let thinkingContent = "";
  let answerContent = "";
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  let finishReason: string | undefined;
  let hasThinking = false;

  for (const chunk of chunks) {
    if (chunk.done) continue;

    if (chunk.phase === "think" && chunk.content) {
      thinkingContent += chunk.content;
      hasThinking = true;
    } else if (chunk.phase === "answer" && chunk.content) {
      answerContent += chunk.content;
    } else if (chunk.content) {
      // No phase — treat as answer content
      answerContent += chunk.content;
    }

    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  // Build content array — ALWAYS an array
  const content: Array<Record<string, unknown>> = [];

  if (hasThinking) {
    content.push({
      type: "thinking",
      thinking: thinkingContent,
      signature: "", // D7 MVP: empty signature
    });
  }

  content.push({
    type: "text",
    text: answerContent,
  });

  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(finishReason),
    stop_sequence: null,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

export function anthropicRoutes(deps: AnthropicRouteDeps) {
  const r = createOpenApiSubApp();

  r.post("/messages", async (c) => {
    // ── anthropic-version header validation ───────────────────────────────
    const anthropicVersion = c.req.header("anthropic-version");
    if (!anthropicVersion || anthropicVersion !== "2023-06-01") {
      return anthropicError(
        c,
        400,
        "invalid_request_error",
        "Missing or invalid anthropic-version header. Expected '2023-06-01'.",
      );
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return anthropicError(c, 400, "invalid_request_error", "Invalid JSON body");
    }

    const b = body as Record<string, unknown>;

    if (!b.model || typeof b.model !== "string") {
      return anthropicError(c, 400, "invalid_request_error", "model is required");
    }

    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return anthropicError(c, 400, "invalid_request_error", "messages is required and must be a non-empty array");
    }

    const modelInput = b.model as string;
    const messages = b.messages as { role: string; content: unknown }[];
    const stream = b.stream === true;

    // ── Model resolution ──────────────────────────────────────────────────
    const aliases = parseModelAliases(deps.config.modelAliasesRaw);
    const resolvedModel = resolveAnthropicModel(modelInput, aliases);

    if (resolvedModel === null) {
      return anthropicError(c, 400, "invalid_request_error", `Model '${modelInput}' not found`);
    }

    // ── System message mapping ────────────────────────────────────────────
    const upstreamMessages: { role: string; content: string }[] = [];

    if (b.system !== undefined && b.system !== null) {
      let systemText: string;
      if (typeof b.system === "string") {
        systemText = b.system;
      } else if (Array.isArray(b.system)) {
        systemText = (b.system as Array<{ type?: string; text?: string }>)
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("");
      } else {
        systemText = "";
      }
      upstreamMessages.push({ role: "system", content: systemText });
    }

    // ── Flatten messages ──────────────────────────────────────────────────
    for (const msg of messages) {
      upstreamMessages.push({
        role: msg.role,
        content: flattenContent(msg.content),
      });
    }

    // ── Non-stream ────────────────────────────────────────────────────────

    if (!stream) {
      try {
        const chunks: QwenChunk[] = await deps.retry(deps, async (_accountId, bearer) => {
          const result: QwenChunk[] = [];
          // Create upstream chat
          const chat = await deps.client.createChat(bearer, {
            model: resolvedModel,
          });
          for await (const chunk of deps.client.chatCompletionsStream(bearer, {
            chatId: chat.chatId,
            model: resolvedModel,
            messages: upstreamMessages,
          })) {
            result.push(chunk);
          }
          return result;
        });

        return c.json(buildAnthropicMessage(modelInput, chunks));
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return poolExhaustedResponse(c, err);
        }
        throw err;
      }
    }

    // ── Stream ────────────────────────────────────────────────────────────

    const qwenStream = deps.retryStream(deps, async function* (
      _accountId: number,
      bearer: string,
    ): AsyncIterable<QwenChunk> {
      // Create upstream chat
      const chat = await deps.client.createChat(bearer, {
        model: resolvedModel,
      });
      yield* deps.client.chatCompletionsStream(bearer, {
        chatId: chat.chatId,
        model: resolvedModel,
        messages: upstreamMessages,
      });
    });

    const anthropicEvents = streamAnthropicEvents(qwenStream, {
      model: modelInput,
      inputTokens: 0, // Actual input tokens unknown until response
    });

    const encoder = new TextEncoder();
    const sseStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of anthropicEvents) {
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return r;
}

function poolExhaustedResponse(c: any, err: PoolExhaustedError) {
  const retryAfterMs = err.earliestReEnableAt
    ? Math.max(0, err.earliestReEnableAt - Date.now())
    : 60_000;
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  c.header("Retry-After", String(retryAfterSec));
  return anthropicError(c, 429, "rate_limit_error", "All accounts rate-limited");
}
