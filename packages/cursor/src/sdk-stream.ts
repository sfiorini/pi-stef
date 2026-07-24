/**
 * SDK stream implementation (stub).
 *
 * In S-62 this will be replaced with the full two-phase streaming logic.
 * For now, every call immediately emits an error event so the provider
 * loads without crashing but does not produce real completions.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/**
 * Stream a Cursor completion (stub — errors immediately).
 *
 * This stub exists so that `index.ts` can register `streamSimple: streamCursorLazy`
 * and typecheck.  The real implementation lands in S-62.
 */
export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  void context;
  void options;

  const stream = createAssistantMessageEventStream();

  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  };

  stream.push({ type: "start", partial });

  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: { ...partial, stopReason: "error", errorMessage: "not yet wired (S-62)" },
    });
    stream.end({ ...partial, stopReason: "error", errorMessage: "not yet wired (S-62)" });
  });

  return stream;
}

/** Lazy alias used by index.ts registration. */
export const streamCursorLazy = streamCursor;
