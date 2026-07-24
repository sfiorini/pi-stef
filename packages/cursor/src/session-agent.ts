/**
 * Session agent pool — wraps an SDK Agent with cross-turn state.
 *
 * A `SessionAgent` holds the paused run, pending bridge, coordinator, and
 * accumulating partial message so that turn N+1 can RESUME the same SDK run
 * rather than starting a fresh `agent.send`.
 *
 * Pool key (5 dimensions): `scopeKey \0 cwd \0 JSON(modelSelection) \0
 * sorted(toolNames) \0 apiKey[:16]`.  Same key → reuse the same wrapper
 * (its currentRun/bridge/coordinator survive across pi turns).
 *
 * NO `@cursor/sdk` import — uses local mirror types.
 */

import { loadCursorSdk, type CursorSdkModule } from "./sdk-runtime.js";
import { CursorSdkTurnCoordinator } from "./turn-coordinator.js";
import { createToolResultBridge, type ToolResultBridge } from "./tool-result-bridge.js";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

// ─── Local mirror types (no @cursor/sdk import) ─────────────────────────────

/** Minimal mirror of the SDK Agent object. */
export interface SDKAgent {
  send(
    message: unknown,
    opts?: Record<string, unknown>,
  ): Promise<SDKRun>;
  close(): Promise<void>;
}

/** Minimal mirror of the SDK Run object. */
export interface SDKRun {
  wait(): Promise<SDKRunResult>;
  cancel(): Promise<void>;
}

/** Minimal mirror of the SDK RunResult. */
export interface SDKRunResult {
  status: string;
  usage?: Record<string, number>;
}

/** Model selection with an id and optional parameters. */
export interface ModelSelection {
  id: string;
  params?: Record<string, unknown>;
}

// ─── SessionAgent wrapper ───────────────────────────────────────────────────

export interface SessionAgent {
  /** The underlying SDK agent instance. */
  agent: SDKAgent;
  /** In-flight run if paused mid-tool (undefined when idle). */
  currentRun?: SDKRun;
  /** Shared across turns of one run. */
  coordinator: CursorSdkTurnCoordinator;
  /** Accumulating assistant message for the run. */
  partial: AssistantMessage;
  /** Pending Cursor tool calls registry. */
  bridge: ToolResultBridge;
  /** For incremental prompts (S-41). */
  lastSentMessageIndex: number;
  /** True until the first send completes. */
  firstTurn: boolean;
  /** Current turn's event stream (retargetable on resume). */
  targetStream?: AssistantMessageEventStream;
  /** Stored model selection for pool key comparison. */
  modelSelection: ModelSelection;
  /** Stored API key. */
  apiKey: string;
}

// ─── Pool ───────────────────────────────────────────────────────────────────

interface PoolEntry {
  session: SessionAgent;
  acquired: boolean;
}

const pool = new Map<string, PoolEntry>();

/**
 * Build the 5-dimensional pool key.
 */
function buildPoolKey(
  scopeKey: string,
  cwd: string,
  modelSelection: ModelSelection,
  toolNames: string[],
  apiKey: string,
): string {
  const sortedTools = toolNames.slice().sort().join(",");
  return `${scopeKey}\0${cwd}\0${JSON.stringify(modelSelection)}\0${sortedTools}\0${apiKey.slice(0, 16)}`;
}

/**
 * Create a fresh partial AssistantMessage for the given model.
 */
function freshPartial(modelId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "cursor-sdk",
    provider: "cursor",
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: undefined as unknown as "stop",
    timestamp: Date.now(),
  };
}

/**
 * Options for acquiring a session agent.
 */
export interface AcquireSessionAgentOpts {
  apiKey: string;
  modelSelection: ModelSelection;
  cwd: string;
  scopeKey: string;
  toolNames: string[];
}

/**
 * Injectable dependencies for testing.
 *
 * `loadSdk` returns `unknown` so tests can supply fakes that only implement
 * the subset of `CursorSdkModule` that `createAgent` actually uses.
 */
export interface AcquireSessionAgentDeps {
  loadSdk?: () => Promise<unknown>;
  createAgent?: (
    sdk: unknown,
    opts: {
      apiKey: string;
      model: ModelSelection;
      mode: string;
      local: { cwd: string; enableAgentRetries: boolean };
    },
  ) => Promise<SDKAgent>;
}

/** Default createAgent that calls the real SDK. */
async function defaultCreateAgent(
  sdk: unknown,
  opts: {
    apiKey: string;
    model: ModelSelection;
    mode: string;
    local: { cwd: string; enableAgentRetries: boolean };
  },
): Promise<SDKAgent> {
  const cursorSdk = sdk as CursorSdkModule;
  return cursorSdk.Agent.create(opts as any) as unknown as Promise<SDKAgent>;
}

/**
 * Acquire a session agent from the pool.
 *
 * Returns the same wrapper if a ready entry exists for the given key.
 * The wrapper's currentRun/bridge/coordinator survive across pi turns.
 */
export async function acquireSessionAgent(
  opts: AcquireSessionAgentOpts,
  deps?: AcquireSessionAgentDeps,
): Promise<{ session: SessionAgent; release: () => void }> {
  const key = buildPoolKey(
    opts.scopeKey,
    opts.cwd,
    opts.modelSelection,
    opts.toolNames,
    opts.apiKey,
  );

  const existing = pool.get(key);
  if (existing) {
    existing.acquired = true;
    return {
      session: existing.session,
      release: () => {
        existing.acquired = false;
      },
    };
  }

  // Create new agent
  const loadSdk = deps?.loadSdk ?? (async () => loadCursorSdk());
  const createAgent = deps?.createAgent ?? defaultCreateAgent;
  const sdk = await loadSdk();
  const agent = await createAgent(sdk, {
    apiKey: opts.apiKey,
    model: opts.modelSelection,
    mode: "agent",
    local: {
      cwd: opts.cwd,
      enableAgentRetries: true,
    },
  });

  const partial = freshPartial(opts.modelSelection.id);
  const bridge = createToolResultBridge();

  // Coordinator is constructed with a push that reads session.targetStream
  // (mutable — retargeted each turn).
  let sessionRef!: SessionAgent;
  const coordinator = new CursorSdkTurnCoordinator(
    partial,
    (e) => sessionRef?.targetStream?.push(e),
  );

  const session: SessionAgent = {
    agent,
    currentRun: undefined,
    coordinator,
    partial,
    bridge,
    lastSentMessageIndex: 0,
    firstTurn: true,
    targetStream: undefined,
    modelSelection: opts.modelSelection,
    apiKey: opts.apiKey,
  };
  sessionRef = session;

  const entry: PoolEntry = { session, acquired: true };
  pool.set(key, entry);

  return {
    session,
    release: () => {
      entry.acquired = false;
    },
  };
}

/**
 * Dispose all pooled session agents.
 *
 * Closes every agent, rejects all pending tool calls, and clears the pool.
 * Idempotent.
 */
export function disposeAllSessionAgents(): void {
  for (const entry of pool.values()) {
    try {
      entry.session.bridge.rejectAll(new Error("disposed"));
    } catch {
      // swallow — best-effort cleanup
    }
    try {
      entry.session.agent.close();
    } catch {
      // swallow — best-effort cleanup
    }
  }
  pool.clear();
}

/**
 * Reset the pool — for use in tests only.
 */
export function __resetSessionAgentPoolForTests(): void {
  disposeAllSessionAgents();
}
