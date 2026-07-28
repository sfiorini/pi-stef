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
  type SDKRunResult,
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
 * Create a ToolCallEmitter that delegates to the coordinator's bridgeToolStart.
 *
 * The coordinator is the SOLE owner of toolcall_start/delta events and content
 * index management.  The bridge emitter just calls bridgeToolStart which is
 * idempotent per callId: if the SDK already started the call, only a delta is
 * emitted; otherwise the coordinator creates the ToolCall block + emits start.
 *
 * This eliminates the old contentIndex:-1 phantom-push bug and ensures exactly
 * one toolcall_start per callId regardless of whether the bridge or SDK fires first.
 */
function makeEmitter(
  session: SessionAgent,
): ToolCallEmitter {
  return {
    start(id: string, name: string, argsJson: string): void {
      session.coordinator.bridgeToolStart(id, name, argsJson);
    },
    delta(id: string, argsJson: string): void {
      // bridgeToolStart is idempotent — if already started, just emits delta
      session.coordinator.bridgeToolStart(id, "", argsJson);
    },
  };
}

// ─── No-hang watchdog (S-M5-3) ───────────────────────────────────────────────

/** Outcome of a no-hang-watched race: the run finished, or it paused on a
 *  further tool call. (Explicit union so raceWithWatchdog<T> type-checks a
 *  heterogeneous competitor array — Promise.race infers this automatically but a
 *  standalone generic helper does not.) */
type WatchedRaceOutcome =
  | { k: "done"; r: SDKRunResult }
  | { k: "paused" };

/**
 * Thrown by the no-hang watchdog when NEITHER `run.wait()` NOR
 * `bridge.whenPending()` settles within the budget — i.e. the run is wedged
 * (parked on a tool call while the @cursor/sdk stall detector cancels it and
 * `enableAgentRetries` silently auto-retries). Surfaced as a terminal error so
 * pi recovers/retries instead of hanging forever.
 */
class WedgedRunError extends Error {
  constructor() {
    super("Cursor run wedged (stall) during tool park — aborted to recover.");
    this.name = "WedgedRunError";
  }
}

/**
 * Resolve the watchdog budget for ONE race (ms). Read PER-CALL (not at module
 * load) so tests can `vi.stubEnv("PI_CURSOR_RUN_WATCHDOG_MS", "50")` and have
 * it take effect — a module-load constant would defeat `stubEnv`. The
 * @cursor/sdk stall budget is internal & not publicly tunable; this bounds the
 * race so a stalled + auto-retried run can never hang pi forever.
 *
 * Precedence: explicit `budgetMs` arg > `PI_CURSOR_RUN_WATCHDOG_MS` env >
 * 120000 (generously above the SDK's ~90s heartbeat but bounded). Invalid /
 * non-positive env → 120000.
 */
function resolveWatchdogMs(budgetMs?: number): number {
  if (budgetMs != null) return budgetMs;
  const parsed = Number.parseInt(
    process.env.PI_CURSOR_RUN_WATCHDOG_MS ?? "120000",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
}

/**
 * Race `competitors` with a bounded watchdog. If NONE settle within the budget,
 * the run is cancelled, pending tool calls rejected, and a `WedgedRunError` is
 * thrown (caller pushes a terminal error) — guaranteeing the stream ALWAYS ends.
 *
 * CRITICAL: each competitor is drained with a no-op `.catch(() => {})` so a
 * LATE rejection from a losing competitor (caused by this function's OWN
 * `cancel()` / `rejectAll()` when the watchdog fires) can NEVER surface as an
 * unhandled rejection (Node >=15 would crash — the exact hang the watchdog
 * exists to prevent). The raced value is untouched.
 */
function raceWithWatchdog<T>(
  session: SessionAgent,
  competitors: Promise<T>[],
  budgetMs?: number,
): Promise<T> {
  // Drain losing/late rejections so the watchdog's own cancel()/rejectAll()
  // can never become an unhandled rejection.
  for (const p of competitors) p.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      (session.currentRun as SDKRun | undefined)?.cancel?.()?.catch?.(() => {});
      session.bridge.rejectAll(
        new Error("Cursor run wedged (stall) — pending tool calls rejected."),
      );
      reject(new WedgedRunError());
    }, resolveWatchdogMs(budgetMs));
    timer.unref?.(); // don't keep the event loop alive for the watchdog alone
  });
  return Promise.race([...competitors, watchdog]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  const _resolveKey = deps?.resolveApiKey ?? (async () => resolveCursorRuntimeApiKey());
  const _acquire = deps?.acquireSessionAgent ?? acquireSessionAgent;
  const _classify = deps?.classifyCursorError ?? classifyCursorError;
  const _buildTools = deps?.buildCustomTools ?? buildCustomTools;

  let session: SessionAgent | undefined;
  let release: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  // P2-a: track abort so cancelled runs emit error, not done
  let aborted = false;

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
    const customTools = _buildTools(bridgeTools, session.bridge, makeEmitter(session));

    // Wire abort handler
    onAbort = (): void => {
      aborted = true;
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

      // Race: resumed run completes OR pauses on a further tool call — bounded
      // by the no-hang watchdog so a stalled run can never hang pi forever.
      let raceResult: WatchedRaceOutcome;
      try {
        raceResult = await raceWithWatchdog<WatchedRaceOutcome>(session, [
          session.currentRun.wait().then((r) => ({ k: "done" as const, r })),
          session.bridge.whenPending().then(() => ({ k: "paused" as const })),
        ]);
      } catch (e) {
        // Only the watchdog (WedgedRunError) is handled here. Any OTHER
        // rejection — notably the abort path where onAbort→cancel()→run.wait()
        // rejects with Error("aborted") — MUST fall through to the outer
        // catch (err) so it is classified correctly (aborted vs error).
        if (!(e instanceof WedgedRunError)) throw e;
        // Watchdog fired: surface a TERMINAL error so pi recovers.
        session.priorRunWasWedged = true; // NEW-TURN force-recovery signal (S-M5-5)
        const p = session.partial;
        p.stopReason = "error";
        p.errorMessage = e.message;
        stream.push({ type: "error", reason: "error", error: p });
        return; // finally still runs release?.() + stream.end(...)
      }

      // POST-RACE logic is UNCHANGED from today: update index, branch on
      // paused/done, honor `aborted`.
      // P1-a: update lastSentMessageIndex so the next NEW TURN only sends new messages
      session.lastSentMessageIndex = context.messages.length;

      if (raceResult.k === "paused") {
        session.currentRun.wait().catch(() => {}); // redundant safety drain (harmless)
        // P2-a: aborted → error, not done
        if (aborted) {
          session.bridge.rejectAll(new Error("aborted"));
          session.partial.stopReason = "aborted";
          session.partial.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: session.partial });
        } else {
          session.partial.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: session.partial });
        }
      } else {
        session.bridge.whenPending().catch(() => {}); // redundant safety drain (harmless)
        // P2-a: aborted → error, not finalize
        if (aborted) {
          session.bridge.rejectAll(new Error("aborted"));
          session.partial.stopReason = "aborted";
          session.partial.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: session.partial });
        } else {
          finalize(session, raceResult.r, stream);
        }
      }
    } else {
      // ═══ NEW TURN phase ═══
      if (!session.firstTurn) {
        // P0 fix: clear partial IN PLACE so the coordinator's _partial
        // reference (set at construction) stays valid.
        session.partial.content.length = 0;
        session.partial.stopReason = undefined as unknown as "stop";
        session.partial.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        session.partial.timestamp = Date.now();
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
      // priorRunWasWedged was set by the watchdog catch (S-M5-3) if the prior
      // run was wedged; it SURVIVES the `session.currentRun = undefined;` clear
      // above, so we key off this explicit flag (not a currentRun.status
      // heuristic, which would be dead code here since currentRun was cleared)
      // to force a clean recovery via the SDK's wedge-recovery knob.
      const priorWedged = !!sess.priorRunWasWedged;
      const run: SDKRun = await sess.agent.send(prompt, {
        onDelta: (a: { update: Record<string, unknown> }) =>
          sess.coordinator.handleDelta(
            a as Parameters<typeof sess.coordinator.handleDelta>[0],
          ),
        onStep: (a: { step: ConversationStep }) =>
          sess.coordinator.handleStep(a),
        local: { customTools, ...(priorWedged ? { force: true } : {}) },
      });
      sess.priorRunWasWedged = false; // reset once the fresh run is engaged
      sess.currentRun = run;

      // Race: run completes OR a tool becomes pending (run paused inside
      // execute) — bounded by the no-hang watchdog so a stalled run can never
      // hang pi forever.
      let raceResult: WatchedRaceOutcome;
      try {
        raceResult = await raceWithWatchdog<WatchedRaceOutcome>(sess, [
          run.wait().then((r) => ({ k: "done" as const, r })),
          sess.bridge.whenPending().then(() => ({ k: "paused" as const })),
        ]);
      } catch (e) {
        // Only the watchdog (WedgedRunError) is handled here; other rejections
        // (e.g. abort via cancel()→run.wait()) fall through to the outer catch.
        if (!(e instanceof WedgedRunError)) throw e;
        // Watchdog fired: surface a TERMINAL error so pi recovers.
        sess.priorRunWasWedged = true; // NEW-TURN force-recovery signal (S-M5-5)
        const p = sess.partial;
        p.stopReason = "error";
        p.errorMessage = e.message;
        stream.push({ type: "error", reason: "error", error: p });
        return;
      }

      if (raceResult.k === "paused") {
        run.wait().catch(() => {}); // redundant safety drain (harmless)
        // P2-a: aborted → error, not done
        if (aborted) {
          sess.bridge.rejectAll(new Error("aborted"));
          sess.partial.stopReason = "aborted";
          sess.partial.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: sess.partial });
        } else {
          sess.partial.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: sess.partial });
        }
      } else {
        sess.bridge.whenPending().catch(() => {}); // redundant safety drain (harmless)
        // P2-a: aborted → error, not finalize
        if (aborted) {
          sess.bridge.rejectAll(new Error("aborted"));
          sess.partial.stopReason = "aborted";
          sess.partial.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: sess.partial });
        } else {
          finalize(sess, raceResult.r, stream);
        }
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

  // A wedged/errored run must map to a TERMINAL status — never left "running"
  // or masquerading as "length"/"stop". Surface it as an error so pi recovers/
  // retries instead of appearing to hang. Exactly one `session.currentRun =
  // undefined` runs on this path (the early return skips the one below).
  // (S-M5-2)
  // A wedged/errored/cancelled run must map to a TERMINAL status — never left
  // "running" or masquerading as "length"/"stop". Any `cancelled` reaching
  // here is SDK-initiated (stall detector / transport): user aborts are caught
  // earlier by the `aborted` flag (error path above finalize). Surface as an
  // error so pi recovers/retries instead of appearing to hang. Exactly one
  // `session.currentRun = undefined` runs on this path (the early return skips
  // the one below). (S-M5-2; audit P2 widened error→cancelled.)
  if (result.status === "error" || result.status === "cancelled") {
    session.partial.stopReason = "error";
    const msg = session.currentRun?.error?.message
      ?? (result.status === "cancelled"
        ? "Cursor run cancelled (SDK stall/transport)"
        : "Cursor run ended with status 'error'");
    session.partial.errorMessage = msg;
    stream.push({ type: "error", reason: "error", error: session.partial });
    session.currentRun = undefined;
    return;
  }

  // `cancelled` can no longer reach here (handled above); `toolUse` precedence
  // is unchanged.
  const reason: "stop" | "length" | "toolUse" = session.bridge.hasPending()
    ? "toolUse"
    : result.status === "finished"
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
