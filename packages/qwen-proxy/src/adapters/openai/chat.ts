/**
 * POST /v1/chat/completions — OpenAI-compatible chat endpoint.
 *
 * Supports both stream and non-stream modes.
 * Resolves model aliases + capability suffixes (-thinking, -search).
 * Pool exhausted → 429 rate_limit_error.
 * Sentinel mid-stream → error event + [DONE] (D14).
 * Function-calling tools/tool_choice passed through to upstream.
 * Details-strip on delta.content only (never reasoning_content).
 */

import { randomUUID } from "node:crypto";
import type { UpstreamClient, OpenAiChatChunk, OpenAiChatCompletion } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn, withPoolRetryStream as WithPoolRetryStreamFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { parseModelAliases, resolveModel } from "../../config/model-aliases";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";
import { stripDetails } from "../../upstream/details-strip";
import { DetailsStreamStripper } from "../../upstream/details-strip";
import { firstChunk, mapOpenAiChunk, TERMINATOR } from "./chunks";
import { injectToolPrompt, injectToolResults, prependToFirstSystemMessage } from "../../upstream/tool-prompt";
import { parseToolCalls } from "../../upstream/tool-parse";

export interface ChatRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "chatCompletions" | "deleteChats">;
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

    // Build upstream body
    const upstreamBody: Record<string, unknown> = {
      model: resolved.upstreamId,
      messages: flatMessages,
      stream,
    };

    // -thinking suffix → enable_thinking:true (default off)
    if (resolved.thinking) {
      upstreamBody.enable_thinking = true;
    }

    // -search suffix → tools:[{type:"web_search"}]
    if (resolved.search) {
      upstreamBody.tools = [{ type: "web_search" }];
    }

    // Explicit enable_thinking passthrough (overrides suffix default)
    if (typeof b.enable_thinking === "boolean") {
      upstreamBody.enable_thinking = b.enable_thinking;
    }

    // Explicit thinking_budget passthrough
    if (typeof b.thinking_budget === "number") {
      upstreamBody.thinking_budget = b.thinking_budget;
    }

    // Tools handling — S-5: detect function tools, inject prompt-engineering
    let toolsInjected = false;
    if (Array.isArray(b.tools)) {
      const functionTools = (b.tools as Array<Record<string, unknown>>).filter(
        (t) => t.type === "function" && t.function,
      );
      if (functionTools.length > 0 && b.tool_choice !== "none") {
        // Function tools present → inject prompt-engineering, strip from upstream
        toolsInjected = true;
        const toolPrompt = injectToolPrompt(b.tools as unknown[], b.tool_choice);
        const rewrittenMessages = injectToolResults(b.messages as any[]);
        flatMessages.length = 0;
        flatMessages.push(...rewrittenMessages);
        prependToFirstSystemMessage(flatMessages, toolPrompt);
        upstreamBody.messages = flatMessages;
        // Strip function tools + tool_choice from upstream body
        const nonFunctionTools = (b.tools as Array<Record<string, unknown>>).filter(
          (t) => t.type !== "function",
        );
        if (nonFunctionTools.length > 0) {
          upstreamBody.tools = nonFunctionTools;
        }
        // tool_choice stripped (only applies to function tools)
      } else {
        // No function tools or tool_choice:"none" → passthrough
        upstreamBody.tools = b.tools;
        if (b.tool_choice !== undefined) {
          upstreamBody.tool_choice = b.tool_choice;
        }
      }
    } else if (b.tool_choice !== undefined) {
      upstreamBody.tool_choice = b.tool_choice;
    }

    // ── Non-stream ────────────────────────────────────────────────────────

    if (!stream) {
      try {
        let usedBearer: string | undefined;
        const completion: OpenAiChatCompletion = await deps.retry(deps, async (_accountId, bearer) => {
          usedBearer = bearer;
          return deps.client.chatCompletions(bearer, { ...upstreamBody, stream: false } as any) as Promise<OpenAiChatCompletion>;
        });

        // Extract content + reasoning from upstream
        const msg = completion.choices?.[0]?.message;
        const content = msg?.content ?? "";
        const reasoningContent = msg?.reasoning_content;
        const upstreamToolCalls = msg?.tool_calls;
        const usage = completion.usage;

        // Strip <details> from content
        const strippedContent = stripDetails(content);

        // S-5: If tools were injected, parse <tool_calls> from response content
        if (toolsInjected && strippedContent) {
          const parsed = parseToolCalls(strippedContent);
          if (parsed.toolCalls && parsed.toolCalls.length > 0) {
            const id = `chatcmpl-${randomUUID()}`;
            const created = Math.floor(Date.now() / 1000);
            const response = c.json({
              id,
              object: "chat.completion" as const,
              created,
              model,
              choices: [{
                index: 0,
                message: {
                  role: "assistant" as const,
                  content: null,
                  tool_calls: parsed.toolCalls,
                },
                finish_reason: "tool_calls",
              }],
              ...(usage ? { usage } : {}),
            });
            // Fire-and-forget cleanup
            if (usedBearer) deps.client.deleteChats(usedBearer).catch(() => {});
            return response;
          }
        }

        const finishReason = completion.choices?.[0]?.finish_reason ?? "stop";

        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        const response = c.json({
          id,
          object: "chat.completion" as const,
          created,
          model, // Original SDK model name (not upstreamId)
          choices: [
            {
              index: 0,
              message: {
                role: "assistant" as const,
                content: strippedContent || null,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                ...(upstreamToolCalls ? { tool_calls: upstreamToolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          ...(usage ? { usage } : {}),
        });
        // Fire-and-forget cleanup
        if (usedBearer) deps.client.deleteChats(usedBearer).catch(() => {});
        return response;
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return poolExhaustedResponse(c, err);
        }
        throw err;
      }
    }

    // ── Stream ────────────────────────────────────────────────────────────

    // A4: Check pool availability BEFORE constructing the 200 SSE Response.
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
    ): AsyncIterable<OpenAiChatChunk> {
      yield* (deps.client.chatCompletions(bearer, { ...upstreamBody, stream: true } as any) as AsyncIterable<OpenAiChatChunk>);
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

          const stripper = new DetailsStreamStripper();
          let sentFinishReason = false;

          for await (const chunk of streamIter) {
            // D14: Check for sentinel ("done" in chunk, but not a real OpenAiChatChunk which always has "choices")
            const isSentinel = ("done" in chunk) && !("choices" in chunk);
            if (isSentinel) {
              if (chunk.extra?.rateLimited) {
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
              }
              break;
            }

            // After sentinel guard, chunk is always a real OpenAiChatChunk
            const c = chunk as OpenAiChatChunk;
            const choice = c.choices?.[0];
            const delta = choice?.delta;

            // Pass reasoning_content through unstripped (but strip co-carried content to
            // prevent unstripped <details> bypass — audit F3)
            if (delta?.reasoning_content) {
              const safeChunk = { ...c, choices: [{ ...choice, delta: { ...delta, content: undefined } }] };
              const mapped = mapOpenAiChunk(safeChunk, id, created, model);
              write(JSON.stringify(mapped));
            }

            // Forward tool_calls (function calling) — pass through, strip co-carried content
            if (delta?.tool_calls) {
              const safeChunk = { ...c, choices: [{ ...choice, delta: { ...delta, content: undefined } }] };
              const mapped = mapOpenAiChunk(safeChunk, id, created, model);
              write(JSON.stringify(mapped));
            }

            // Strip <details> from delta.content
            if (delta?.content !== undefined) {
              const safe = stripper.push(delta.content);
              if (safe) {
                const mapped = mapOpenAiChunk(
                  { choices: [{ ...choice, delta: { content: safe } }] },
                  id,
                  created,
                  model,
                );
                write(JSON.stringify(mapped));
              }
            }

            // Forward finish_reason (but strip co-carried content to prevent
            // unstripped <details> bypass — audit F3)
            if (choice?.finish_reason) {
              const safeChunk = { ...c, choices: [{ ...choice, delta: { ...delta, content: undefined } }] };
              const mapped = mapOpenAiChunk(safeChunk, id, created, model);
              write(JSON.stringify(mapped));
              sentFinishReason = true;
            }

            // Forward usage
            if (c.usage && !choice?.finish_reason && !choice?.delta?.content && !choice?.delta?.reasoning_content) {
              // Pure usage chunk (no content/finish/reasoning)
              const mapped = mapOpenAiChunk(c, id, created, model);
              write(JSON.stringify(mapped));
            }
          }

          // Flush any remaining buffer from the stripper
          const tail = stripper.finalize();
          if (tail) {
            write(JSON.stringify(mapOpenAiChunk(
              { choices: [{ delta: { content: tail } }] },
              id,
              created,
              model,
            )));
          }

          // Emit synthetic finish_reason:"stop" if upstream didn't send one
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
