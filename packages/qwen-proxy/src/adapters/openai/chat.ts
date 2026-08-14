/**
 * POST /v1/chat/completions — OpenAI-compatible chat endpoint.
 *
 * Supports both stream and non-stream modes.
 * Resolves model aliases + capability suffixes (-thinking, -search).
 * Pool exhausted → 429 rate_limit_error.
 * Sentinel mid-stream → error event + [DONE] (D14).
 * Function-calling tools prompt-engineered (stripped from upstream body, injected into system prompt).
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
import { injectToolPrompt, injectToolResults, prependToFirstSystemMessage, appendToolListToLastMessage } from "../../upstream/tool-prompt";
import { parseToolCalls } from "../../upstream/tool-parse";
import { ToolStreamDetector } from "../../upstream/tool-stream";

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

/**
 * Flatten multi-turn conversation into a single user message.
 * chat.qwen.ai guest mode only forwards the last message —
 * prior messages in the array are ignored. This concatenates ALL
 * non-system messages into one user message so the model sees full context.
 */
function flattenForUpstream(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const convoMsgs = messages.filter((m) => m.role !== "system");
  if (convoMsgs.length <= 1) return messages;
  const systemContent = systemMsgs.map((m) => m.content).join("\n\n");
  const conversationText = convoMsgs
    .map((m) => {
      const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      return `${label}: ${m.content}`;
    })
    .join("\n\n");
  const result: Array<{ role: string; content: string }> = [];
  if (systemContent) result.push({ role: "system", content: systemContent });
  result.push({ role: "user", content: conversationText });
  return result;
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
    let isContinuation = false;
    if (Array.isArray(b.tools)) {
      const functionTools = (b.tools as Array<Record<string, unknown>>).filter(
        (t) => t.type === "function" && t.function,
      );
      if (functionTools.length > 0 && b.tool_choice !== "none") {
        // Function tools present → inject prompt-engineering, strip from upstream
        toolsInjected = true;
        const rewrittenMessages = injectToolResults(b.messages as any[]);
        flatMessages.length = 0;
        flatMessages.push(...rewrittenMessages);
        // Continuation turns (history already carries tool calls/results) skip
        // the tool-prompt injection: live-debugged on mini (2026-08-14), qwen
        // suppresses the answer server-side — streams zero content/reasoning
        // deltas while consuming ~47 completion tokens — when the injected
        // "# Available Tools" system block is present on a continuation. With
        // no injection the same body answers normally. The <tool_calls>
        // convention remains available in-context from the rewritten history
        // (prior assistant tool_calls are rewritten as <tool_calls> text), so
        // chained tool rounds still parse.
        // Detect on the ORIGINAL request messages: the adapter flattens
        // multi-turn history for guest mode (assistant turns fold into a
        // synthesized user message), so rewrittenMessages may carry no
        // assistant role at all.
        // Require a preceding assistant tool_calls (not a bare tool message):
        // the in-context <tool_calls> convention the model relies on comes
        // from that assistant turn — without it the format still needs priming.
        // (Declared at this scope level so the post-flatten append below can see it.)
        isContinuation = (b.messages as Array<Record<string, unknown>>).some(
          (m) =>
            m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0,
        );
        if (!isContinuation) {
          const toolPrompt = injectToolPrompt(b.tools as unknown[], b.tool_choice);
          prependToFirstSystemMessage(flatMessages, toolPrompt);
        }
        // Continuation turns append the tool list AFTER flattening (below) —
        // qwen suppresses answers when the tool prompt sits in the SYSTEM
        // message (live-debugged on mini 2026-08-14: zero content/reasoning
        // deltas, ~47 tokens consumed, deterministic across ~20 attempts).
        // Appending to the final flattened turn keeps tool discovery for
        // multi-tool loops while avoiding the system-position trigger.
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

    // chat.qwen.ai guest mode only forwards the last message — flatten multi-turn
    upstreamBody.messages = flattenForUpstream(upstreamBody.messages as Array<{ role: string; content: string }>);

    // Continuation turn (history already carries tool calls/results): append
    // the tool list to the LAST (flattened) message — see the tools-handling
    // block above for the suppression rationale.
    if (toolsInjected && isContinuation) {
      appendToolListToLastMessage(
        upstreamBody.messages as Array<{ role: string; content: string }>,
        b.tools as unknown[],
      );
    }

    // ── Non-stream ────────────────────────────────────────────────────────

    if (!stream) {
      try {
        let usedBearer: string | undefined;
        const completion: OpenAiChatCompletion = await deps.retry(deps, async (_accountId, bearer, proxy?) => {
          usedBearer = bearer;
          return deps.client.chatCompletions(bearer, { ...upstreamBody, stream: false } as any, proxy) as Promise<OpenAiChatCompletion>;
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
        // F1: Always use parsed.content (tag-stripped) when toolsInjected
        let responseContent: string | null = strippedContent || null;
        if (toolsInjected && strippedContent) {
          const parsed = parseToolCalls(strippedContent);
          responseContent = parsed.content;
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
                content: responseContent,
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

    let usedBearer: string | undefined;
    const streamIter = deps.retryStream(deps, async function* (
      _accountId: number,
      bearer: string,
      proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      usedBearer = bearer;
      yield* (deps.client.chatCompletions(bearer, { ...upstreamBody, stream: true } as any, proxy) as AsyncIterable<OpenAiChatChunk>);
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
          const toolDetector = toolsInjected ? new ToolStreamDetector() : null;
          let streamGotToolCalls = false;
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
            // S-6: gate on !toolsInjected (when injected, we own tool-call detection)
            if (delta?.tool_calls && !toolsInjected) {
              const safeChunk = { ...c, choices: [{ ...choice, delta: { ...delta, content: undefined } }] };
              const mapped = mapOpenAiChunk(safeChunk, id, created, model);
              write(JSON.stringify(mapped));
            }

            // S-6: Strip <details> from delta.content (with tool-call detection)
            if (delta?.content !== undefined) {
              if (toolsInjected && toolDetector) {
                // Feed content through ToolStreamDetector
                const result = toolDetector.push(delta.content);
                if (result.content !== undefined && result.content) {
                  const safe = stripper.push(result.content);
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
                if (result.toolCallsReady) {
                  const completedBlock = toolDetector.completedBlock;
                  const parsed = parseToolCalls(completedBlock);
                  if (parsed.toolCalls && parsed.toolCalls.length > 0) {
                    write(JSON.stringify(mapOpenAiChunk(
                      { choices: [{ delta: { tool_calls: parsed.toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: tc.type, function: tc.function })) } }] },
                      id,
                      created,
                      model,
                    )));
                    streamGotToolCalls = true;
                  }
                }
              } else {
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
            }

            // Forward finish_reason (but strip co-carried content to prevent
            // unstripped <details> bypass — audit F3)
            // S-6: override to "tool_calls" when tools were injected and tool calls detected
            if (choice?.finish_reason) {
              const finishReason = toolsInjected && streamGotToolCalls ? "tool_calls" : choice.finish_reason;
              const safeChunk = { ...c, choices: [{ ...choice, delta: { ...delta, content: undefined }, finish_reason: finishReason }] };
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

          // S-6: Flush toolDetector first
          if (toolDetector) {
            const detResult = toolDetector.finalize();
            if (detResult.content !== undefined && detResult.content) {
              const tailContent = stripper.push(detResult.content);
              if (tailContent) {
                write(JSON.stringify(mapOpenAiChunk(
                  { choices: [{ delta: { content: tailContent } }] },
                  id,
                  created,
                  model,
                )));
              }
            }
            // BUFFERING→discard: content field absent (Q4) — nothing to emit
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

          // Emit synthetic finish_reason if upstream didn't send one
          // S-6: "tool_calls" if tool calls detected, else "stop"
          if (!sentFinishReason) {
            const syntheticReason = toolsInjected && streamGotToolCalls ? "tool_calls" : "stop";
            write(
              JSON.stringify({
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    logprobs: null,
                    finish_reason: syntheticReason,
                  },
                ],
              }),
            );
          }

          // Terminator
          controller.enqueue(encoder.encode(TERMINATOR));
          controller.close();

          // S-6: Fire-and-forget cleanup after stream closes
          if (usedBearer) deps.client.deleteChats(usedBearer).catch(() => {});
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
