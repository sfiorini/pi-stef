/**
 * SDK stream implementation — two-phase `streamCursor`.
 *
 * **RESUME phase:** the session has pending tool calls from a prior turn.
 *   The run is still alive; we resolve pending calls from tool-result messages
 *   in `context.messages` and let the resumed run continue.
 *
 * **NEW TURN phase:** no pending tool calls. Fresh partial + coordinator reset
 *   (unless it's the very first turn). Prompt is full or incremental.
 *
 * Robustness: the ENTIRE runPhase body is wrapped in try/catch/finally so
 * acquire/loadSdk/send failures are classified and the stream ALWAYS ends
 * and the session is ALWAYS released.
 *
 * Dedup approach: the turn-coordinator is the SOLE owner of
 * toolcall_start/delta/end events (emitted from the SDK's onDelta callback).
 * The bridge's ToolCallEmitter is a no-op — this avoids duplicate events.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Message,
} from "@earendil-works/pi-ai";
import { applyHttp1Config } from "./http1-config.js";
import { resolveCursorRuntimeApiKey } from "./api-key.js";
import { loadCursorSdk, type CursorSdkModule } from "./sdk-runtime.js";
import {
  acquireSessionAgent,
  type AcquireSessionAgentDeps,
  type SDKRun,
  type SessionAgent,
} from "./session-agent.js";
import { buildFullContextPrompt, buildIncrementalPrompt } from "./context-builder.js";
import { buildCustomTools, type ToolCallEmitter } from "./tool-bridge.js";
import { classifyCursorError } from "./provider-errors.js";
import type { ConversationStep } from "./turn-coordinator.js";

// ─── Injectable deps (for testing) ──────────────────────────────────────────

export interface StreamCursorDeps {
  loadSdk?: () => Promise<CursorSdkModule>;
  applyHttp1Config?: () => Promise<void>;
  resolveApiKey?: () => Promise<string | undefined>;
  acquireSessionAgent?: typeof acquireSessionAgent;
  classifyCursorError?: (err: unknown) => Promise<{ reason: string; message: string }>;
  buildCustomTools?: typeof buildCustomTools;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a fresh assistant message with empty content.
 */
function freshAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "cursor-sdk",
    provider: "cursor",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: undefined as unknown as "stop",
    timestamp: Date.now(),
  };
}

/**
 * Strip `cursor/` prefix from a model id to get the SDK's model name.
 */
function stripProviderPrefix(id: string): string {
  return id.replace(/^cursor\//, "");
}

/**
 * Extract tool names from pi-ai Context.tools (which use `name` directly,
 * not the OpenAI `function.name` wrapper).
 */
function extractToolNames(
  tools: Context["tools"],
): string[] {
  if (!tools) return [];
  return tools.map((t) => t.name);
}

/**
 * Convert pi-ai `Tool[]` to the `PiTool[]` shape that `buildCustomTools` expects.
 * pi-ai Tool: { name, description, parameters }
 * buildCustomTools PiTool: { function: { name, description, parameters } }
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function piToolsToBridgeFormat(
  tools: Context["tools"],
): Array<{ function: { name: string; description?: string; parameters?: Record<string, unknown> } }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Extract tool results from pi ToolResultMessage entries in the message list.
 *
 * Shape (verified from @earendil-works/pi-ai types.d.ts):
 *   { role: "toolResult", toolCallId: string, toolName: string,
 *     content: (TextContent|ImageContent)[], isError: boolean, timestamp: number }
 */
function extractToolResults(
  messages: readonly Message[],
): Array<{ toolCallId: string; text: string; isError?: boolean }> {
  const results: Array<{ toolCallId: string; text: string; isError?: boolean }> = [];

  for (const msg of messages) {
    if ((msg as { role?: string }).role !== "toolResult") continue;
    const m = msg as {
      toolCallId: string;
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    results.push({ toolCallId: m.toolCallId, text, isError: m.isError });
  }

  return results;
}

/**
 * Build a no-op ToolCallEmitter.
 *
 * The turn-coordinator owns ALL toolcall_start / toolcall_delta / toolcall_end
 * events (from the SDK's onDelta callback).  The bridge's emitter is a no-op
 * to avoid DUPLICATE pi toolcall events.
 */
function makeNoopEmitter(): ToolCallEmitter {
  return {
    start(): void { /* no-op — coordinator owns toolcall_start from onDelta */ },
    delta(): void { /* no-op — coordinator owns toolcall_delta from onDelta */ },
  };
}

// ─── streamCursor ────────────────────────────────────────────────────────────

/**
 * Stream a Cursor completion — the core of cross-turn tool continuity.
 *
 * Two-phase branching on `session.bridge.hasPending()`:
 *   RESUME — tool results from prior turn → resolved → resumed run continues
 *   NEW TURN — fresh run (full or incremental prompt)
 *
 * The stream ALWAYS ends in the finally block.
 */
export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  deps?: StreamCursorDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void runPhase(model, context, options, stream, deps);

  return stream;
}

async function runPhase(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  deps?: StreamCursorDeps,
): Promise<void> {
  const _loadSdk = deps?.loadSdk ?? loadCursorSdk;
  const _applyHttp1 = deps?.applyHttp1Config ?? applyHttp1Config;
  const _resolveKey = deps?.resolveApiKey ?? (async () =>
    resolveCursorRuntimeApiKey({
      readStoredCredential: async () => undefined,
      envApiKey: process.env.CURSOR_API_KEY,
      fallbackApiKey: undefined,
    })
  );
  const _acquire = deps?.acquireSessionAgent ?? acquireSessionAgent;
  const _classify = deps?.classifyCursorError ?? classifyCursorError;
  const _buildTools = deps?.buildCustomTools ?? buildCustomTools;

  let session: SessionAgent | undefined;
  let release: (() => void) | undefined;
  let onAbort: (() => void) | undefined;

  // Track the best available final message for stream.end() in finally.
  let finalMessage: AssistantMessage = freshAssistantMessage(model);

  try {
    await _applyHttp1();

    const apiKey = await _resolveKey();
    if (!apiKey) {
      finalMessage.stopReason = "error";
      finalMessage.errorMessage =
        "No Cursor API key. Run /cursor-login <key> or set CURSOR_API_KEY.";
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "error", reason: "error", error: finalMessage });
      return;
    }

    // SDK is loaded for error classification in catch block
    await _loadSdk();

    const toolNames = extractToolNames(context.tools);
    const acquired = await _acquire(
      {
        apiKey,
        modelSelection: { id: stripProviderPrefix(model.id) },
        cwd: process.cwd(),
        scopeKey: (options as { sessionId?: string } | undefined)?.sessionId ?? "default",
        toolNames,
      },
      undefined as unknown as AcquireSessionAgentDeps,
    );
    session = acquired.session;
    release = acquired.release;

    // Retarget the coordinator to THIS turn's stream
    session.targetStream = stream;

    const bridgeTools = piToolsToBridgeFormat(context.tools);
    const customTools = _buildTools(bridgeTools, session.bridge, makeNoopEmitter());

    // Wire abort handler
    onAbort = (): void => {
      (session?.currentRun as SDKRun | undefined)?.cancel?.()?.catch?.(() => {});
      session?.bridge?.rejectAll(new Error("aborted"));
    };
    options?.signal?.addEventListener("abort", onAbort);

    // ─── Two-phase branch ───────────────────────────────────────────────

    if (session.bridge.hasPending()) {
      // ═══ RESUME phase ═══
      if (!session.currentRun) {
        const p = session.partial;
        p.stopReason = "error";
        p.errorMessage = "No active Cursor run to resume.";
        stream.push({ type: "start", partial: p });
        stream.push({ type: "error", reason: "error", error: p });
        return;
      }

      stream.push({ type: "start", partial: session.partial });

      const toolResults = extractToolResults(context.messages);
      const resolved = session.bridge.resolveFromToolResults(toolResults);

      if (resolved.length === 0 && session.bridge.hasPending()) {
        const ids = session.bridge.pendingToolCallIds().join(", ");
        const p = session.partial;
        p.stopReason = "error";
        p.errorMessage = `No tool result supplied for pending Cursor tool call(s): ${ids}`;
        stream.push({ type: "error", reason: "error", error: p });
        return;
      }

      // Race: resumed run completes OR pauses on a further tool call
      const raceResult = await Promise.race([
        session.currentRun
          .wait()
          .then((r) => ({ k: "done" as const, r })),
        session.bridge.whenPending().then(() => ({ k: "paused" as const })),
      ]);

      // Drain the losing promise to avoid unhandled rejection
      if (raceResult.k === "paused") {
        session.currentRun.wait().catch(() => {});
        session.partial.stopReason = "toolUse";
        stream.push({
          type: "done",
          reason: "toolUse",
          message: session.partial,
        });
      } else {
        session.bridge.whenPending().catch(() => {});
        finalize(session, raceResult.r, stream);
      }
    } else {
      // ═══ NEW TURN phase ═══
      if (!session.firstTurn) {
        session.partial = freshAssistantMessage(model);
        session.coordinator.reset();
      }
      session.currentRun = undefined;

      stream.push({ type: "start", partial: session.partial });

      const prompt = session.firstTurn
        ? buildFullContextPrompt(context)
        : buildIncrementalPrompt(context, session.lastSentMessageIndex);
      session.lastSentMessageIndex = context.messages.length;
      session.firstTurn = false;

      // Capture session in a local const for the callbacks
      const sess = session;
      const run: SDKRun = await sess.agent.send(prompt, {
        onDelta: (a: { update: Record<string, unknown> }) =>
          sess.coordinator.handleDelta(
            a as Parameters<typeof sess.coordinator.handleDelta>[0],
          ),
        onStep: (a: { step: ConversationStep }) =>
          sess.coordinator.handleStep(a),
        local: { customTools },
      });
      sess.currentRun = run;

      // Race: run completes OR a tool becomes pending (run paused inside execute)
      const raceResult = await Promise.race([
        run
          .wait()
          .then((r) => ({ k: "done" as const, r })),
        sess.bridge.whenPending().then(() => ({ k: "paused" as const })),
      ]);

      // Drain the losing promise
      if (raceResult.k === "paused") {
        run.wait().catch(() => {});
        sess.partial.stopReason = "toolUse";
        stream.push({
          type: "done",
          reason: "toolUse",
          message: sess.partial,
        });
      } else {
        sess.bridge.whenPending().catch(() => {});
        finalize(sess, raceResult.r, stream);
      }
    }
  } catch (err) {
    const classified = await _classify(err);
    const p = session?.partial ?? finalMessage;
    p.stopReason = classified.reason === "aborted" ? "aborted" : "error";
    p.errorMessage = classified.message;
    finalMessage = p;
    stream.push({
      type: "error",
      reason: classified.reason === "aborted" ? "aborted" : "error",
      error: p,
    });
  } finally {
    if (onAbort && options?.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
    release?.();
    stream.end(session?.partial ?? finalMessage);
  }
}

// ─── finalize ────────────────────────────────────────────────────────────────

function finalize(
  session: SessionAgent,
  result: { status: string; usage?: Record<string, number> },
  stream: AssistantMessageEventStream,
): void {
  // Prefer coordinator usage (from turn-ended delta) over result.usage
  const coordUsage = session.coordinator.usage;
  if (coordUsage.inputTokens || coordUsage.outputTokens) {
    session.partial.usage.input = coordUsage.inputTokens ?? 0;
    session.partial.usage.output = coordUsage.outputTokens ?? 0;
    session.partial.usage.cacheRead = coordUsage.cacheReadTokens ?? 0;
    session.partial.usage.cacheWrite = coordUsage.cacheWriteTokens ?? 0;
  } else if (result.usage) {
    session.partial.usage.input = result.usage.inputTokens ?? 0;
    session.partial.usage.output = result.usage.outputTokens ?? 0;
    session.partial.usage.cacheRead = result.usage.cacheReadTokens ?? 0;
    session.partial.usage.cacheWrite = result.usage.cacheWriteTokens ?? 0;
  }
  session.partial.usage.totalTokens =
    session.partial.usage.input + session.partial.usage.output;

  const reason: "stop" | "length" | "toolUse" = session.bridge.hasPending()
    ? "toolUse"
    : result.status === "cancelled" || result.status === "finished"
      ? "stop"
      : "length";

  session.partial.stopReason = reason;
  stream.push({ type: "done", reason, message: session.partial });

  // Clear the settled run so the next NEW turn starts fresh
  session.currentRun = undefined;
}

// ─── Lazy alias ──────────────────────────────────────────────────────────────

/** Lazy alias used by index.ts registration. */
export const streamCursorLazy = streamCursor;
