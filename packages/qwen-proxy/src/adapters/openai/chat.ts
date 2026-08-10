/**
 * POST /v1/chat/completions — OpenAI-compatible chat endpoint.
 *
 * Supports both stream and non-stream modes.
 * Resolves model aliases + capability suffixes (-thinking, -search).
 * Pool exhausted → 429 rate_limit_error.
 * Sentinel mid-stream → error event + [DONE] (D14).
 */

import { randomUUID } from "node:crypto";
import type { UpstreamClient, QwenChunk } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn, withPoolRetryStream as WithPoolRetryStreamFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { parseModelAliases, resolveModel } from "../../config/model-aliases";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";
import { firstChunk, mapChunk, TERMINATOR } from "./chunks";

export interface ChatRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "createChat" | "chatCompletionsStream">;
  retry: typeof WithPoolRetryFn;
  retryStream: typeof WithPoolRetryStreamFn;
  config: RetryDeps["config"] & { modelAliasesRaw: string };
}

/**
 * Check if a model base ID is a known Qwen/Wan model or is in the alias map.
 * Used to reject unknown model names with a clean 400.
 */
function isKnownOpenAiModel(base: string, aliases: Map<string, string>): boolean {
  // 1. Explicit alias
  if (aliases.has(base)) return true;
  // 2. Known Qwen/Wan model patterns
  if (/^qwen/i.test(base) || /^wan/i.test(base)) return true;
  return false;
}

/**
 * Flatten a message content field to a plain string.
 * content can be string OR [{type:"text",text}].
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => {
        const p = part as Record<string, unknown>;
        return p && p.type === "text" && typeof p.text === "string";
      })
      .map((part: unknown) => (part as { text: string }).text)
      .join("");
  }
  return "";
}

export function chatRoutes(deps: ChatRouteDeps) {
  const r = createOpenApiSubApp();

  r.post("/chat/completions", async (c) => {
    // Parse body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(c, 400, "Invalid JSON body", { code: "bad_request" });
    }

    const b = body as Record<string, unknown>;

    // Validate required fields
    if (!b.model || typeof b.model !== "string") {
      return openaiError(c, 400, "model is required", {
        code: "invalid_request_error",
        param: "model",
      });
    }

    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return openaiError(c, 400, "messages is required and must be a non-empty array", {
        code: "invalid_request_error",
        param: "messages",
      });
    }

    const model = b.model as string;
    const messages = b.messages as { role: string; content: unknown }[];
    const stream = b.stream === true;

    // Resolve model (aliases + suffixes)
    const aliases = parseModelAliases(deps.config.modelAliasesRaw);
    const resolved = resolveModel(model, aliases);

    // F3: Validate model is known (alias or qwen/wan pattern)
    if (!isKnownOpenAiModel(resolved.upstreamId, aliases)) {
      return openaiError(c, 400, `Model '${model}' not found`, {
        code: "model_not_found",
        param: "model",
      });
    }

    // Flatten messages to upstream format
    const flatMessages = messages.map((m) => ({
      role: m.role,
      content: flattenContent(m.content),
    }));

    // Determine chat params
    const chatType = resolved.search ? "search" : "t2t";
    const featureConfig = resolved.thinking
      ? { thinking_enabled: true }
      : undefined;

    // ── Non-stream ────────────────────────────────────────────────────────

    if (!stream) {
      try {
        const chunks: QwenChunk[] = await deps.retry(deps, async (_accountId, bearer) => {
          const result: QwenChunk[] = [];
          // Create upstream chat inside retry (F1: failover on 429)
          const chat = await deps.client.createChat(bearer, {
            model: resolved.upstreamId,
            chatType,
          });
          for await (const chunk of deps.client.chatCompletionsStream(bearer, {
            chatId: chat.chatId,
            model: resolved.upstreamId,
            messages: flatMessages,
            featureConfig,
          })) {
            result.push(chunk);
          }
          return result;
        });

        // Accumulate reasoning_content + content + usage
        let reasoningContent = "";
        let content = "";
        let finishReason: string | null = null;
        let usage: Record<string, unknown> | undefined;

        for (const chunk of chunks) {
          if (chunk.done) continue;

          if (chunk.phase === "think" && chunk.content) {
            reasoningContent += chunk.content;
          } else if (chunk.phase === "answer" && chunk.content) {
            content += chunk.content;
          } else if (chunk.content) {
            // No phase — treat as answer content
            content += chunk.content;
          }

          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }

        if (!content && !reasoningContent) {
          deps.log.warn("chat completion produced no content", {
            chunkCount: chunks.length,
            phases: chunks.map((c) => c.phase ?? null),
          });
        }

        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        return c.json({
          id,
          object: "chat.completion" as const,
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant" as const,
                content: content || null,
                reasoning_content: reasoningContent || null,
              },
              finish_reason: finishReason ?? "stop",
            },
          ],
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return poolExhaustedResponse(c, err);
        }
        throw err;
      }
    }

    // ── Stream ────────────────────────────────────────────────────────────

    // A4: Check pool availability BEFORE constructing the 200 SSE Response.
    // Otherwise PoolExhaustedError thrown inside the ReadableStream start
    // callback results in a truncated 200 instead of a 429.
    try {
      deps.pool.getActiveAccount();
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return poolExhaustedResponse(c, err);
      }
      throw err;
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const streamIter = deps.retryStream(deps, async function* (
      _accountId: number,
      bearer: string,
    ): AsyncIterable<QwenChunk> {
      // Create upstream chat inside retry (F1: failover on 429)
      const chat = await deps.client.createChat(bearer, {
        model: resolved.upstreamId,
        chatType,
      });
      yield* deps.client.chatCompletionsStream(bearer, {
        chatId: chat.chatId,
        model: resolved.upstreamId,
        messages: flatMessages,
        featureConfig,
      });
    });

    const encoder = new TextEncoder();

    const sseStream = new ReadableStream({
      async start(controller) {
        const write = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        try {
          // First chunk: delta.role = "assistant"
          write(JSON.stringify(firstChunk(id, created, model)));

          let sentFinishReason = false;

          for await (const chunk of streamIter) {
            // Check for sentinel (D14)
            if (chunk.done && chunk.extra?.rateLimited) {
              // Rate limit error mid-stream
              write(
                JSON.stringify({
                  error: {
                    message: "rate limit exceeded",
                    type: "rate_limit_error",
                    code: "rate_limit_exceeded",
                  },
                }),
              );
              // No finish_reason chunk — go straight to [DONE]
              controller.enqueue(encoder.encode(TERMINATOR));
              controller.close();
              return;
            }

            if (chunk.done) {
              // Clean end
              break;
            }

            const mapped = mapChunk(chunk);
            if (mapped) {
              write(JSON.stringify(mapped));
            }

            // Track finish reason
            if (chunk.finishReason && !sentFinishReason) {
              sentFinishReason = true;
            }
          }

          // Emit finish_reason:"stop" if not already sent
          if (!sentFinishReason) {
            write(
              JSON.stringify({
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    logprobs: null,
                    finish_reason: "stop",
                  },
                ],
              }),
            );
          }

          // Terminator
          controller.enqueue(encoder.encode(TERMINATOR));
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

function poolExhaustedResponse(c: { header: (name: string, value: string) => void }, err: PoolExhaustedError) {
  const retryAfterMs = err.earliestReEnableAt
    ? Math.max(0, err.earliestReEnableAt - Date.now())
    : 60_000;
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  c.header("Retry-After", String(retryAfterSec));
  return (c as any).json(
    {
      error: {
        message: "All accounts rate-limited",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    },
    429,
  );
}
