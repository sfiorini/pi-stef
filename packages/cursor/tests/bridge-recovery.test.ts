import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Context, Model } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __testInternals,
  buildCursorRequest,
  commitStoredCheckpointMidPause,
  createCursorNativeStream,
  deriveBridgeKey,
  deriveConversationKey,
  formatLostToolContinuationDiagnostic,
  handleBridgeCloseMidPause,
  lostToolContinuationErrorBody,
  parseMessages,
  planRecovery,
  resolveActiveBridgeTtlMs,
  setBridgeFactoryForTests,
  startProxy,
  stopProxy,
  wrapRecoveredToolResults,
  type ParsedTurn,
  type StoredConversation,
} from "../src/proxy";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  McpToolErrorSchema,
  McpToolResultSchema,
  TextDeltaUpdateSchema,
  ToolCallCompletedUpdateSchema,
  TokenDeltaUpdateSchema,
  type ConversationStateStructure,
} from "../src/proto/agent_pb";
import {
  __testInternals as bridgeInternals,
  frameConnectMessage,
  type BridgeHandle,
} from "../src/bridge";

let debugLogFileForCleanup: string | undefined;
const noopMetricEmitter = () => undefined;
__testInternals.setMetricEmitterForTests(noopMetricEmitter);

function readDebugEvents(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.useRealTimers();
  if (debugLogFileForCleanup) {
    try {
      unlinkSync(debugLogFileForCleanup);
    } catch {}
    debugLogFileForCleanup = undefined;
  }
  delete process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS;
  delete process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS;
  delete process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES;
  delete process.env.PI_CURSOR_MIDPAUSE_REBUILD_MAX_AGE_MS;
  delete process.env.PI_CURSOR_PROVIDER_DEBUG;
  delete process.env.PI_CURSOR_PROVIDER_DEBUG_FILE;
  __testInternals.setMetricEmitterForTests(noopMetricEmitter);
  stopProxy();
  setBridgeFactoryForTests();
  __testInternals.activeBridges.clear();
  __testInternals.conversationStates.clear();
});

function makeCursorModel(id = "gpt-5.4"): Model<"cursor-native"> {
  return {
    id,
    name: id,
    api: "cursor-native",
    provider: "cursor",
    baseUrl: "https://api2.cursor.sh",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function makeUserContext(text = "hello"): Context {
  return {
    messages: [{ role: "user", content: text, timestamp: Date.now() }],
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function installSilentBridge() {
  const captured: {
    writes: Uint8Array[];
    ended: boolean;
    killed: boolean;
    dataCb?: (chunk: Buffer) => void;
    closeCb?: (code: number) => void;
  } = { writes: [], ended: false, killed: false };

  setBridgeFactoryForTests(() => {
    const handle: BridgeHandle = {
      proc: {
        kill: () => {
          captured.killed = true;
          captured.closeCb?.(1);
          return true;
        },
      },
      get alive() {
        return !captured.ended && !captured.killed;
      },
      write(data: Uint8Array) {
        captured.writes.push(new Uint8Array(data));
      },
      end() {
        captured.ended = true;
      },
      onData(cb) {
        captured.dataCb = cb;
      },
      onClose(cb) {
        captured.closeCb = cb;
      },
      onResponseEnd() {},
    };
    return handle;
  });

  return captured;
}

function installRetryBridgeFactory(options: { succeedOnAttempt?: number } = {}) {
  const attempts: Array<{
    writes: Uint8Array[];
    ended: boolean;
    killed: boolean;
    closeCb?: (code: number) => void;
    dataCb?: (chunk: Buffer) => void;
  }> = [];

  setBridgeFactoryForTests(() => {
    const attemptNumber = attempts.length + 1;
    const captured = { writes: [], ended: false, killed: false } as {
      writes: Uint8Array[];
      ended: boolean;
      killed: boolean;
      closeCb?: (code: number) => void;
      dataCb?: (chunk: Buffer) => void;
    };
    attempts.push(captured);

    const handle: BridgeHandle = {
      proc: {
        kill: () => {
          captured.killed = true;
          captured.closeCb?.(1);
          return true;
        },
      },
      get alive() {
        return !captured.ended && !captured.killed;
      },
      write(data: Uint8Array) {
        captured.writes.push(new Uint8Array(data));
        if (options.succeedOnAttempt === attemptNumber && captured.writes.length === 1) {
          queueMicrotask(() => {
            captured.ended = true;
            captured.closeCb?.(0);
          });
        }
      },
      end() {
        captured.ended = true;
      },
      onData(cb) {
        captured.dataCb = cb;
      },
      onClose(cb) {
        captured.closeCb = cb;
      },
      onResponseEnd() {},
    };
    return handle;
  });

  return attempts;
}

function makeManualSilentBridge() {
  const captured: {
    writes: Uint8Array[];
    ended: boolean;
    killed: boolean;
    closeCb?: (code: number) => void;
    dataCb?: (chunk: Buffer) => void;
  } = { writes: [], ended: false, killed: false };

  const handle: BridgeHandle = {
    proc: {
      kill: () => {
        captured.killed = true;
        captured.closeCb?.(1);
        return true;
      },
    },
    get alive() {
      return !captured.ended && !captured.killed;
    },
    write(data: Uint8Array) {
      captured.writes.push(new Uint8Array(data));
    },
    end() {
      captured.ended = true;
    },
    onData(cb) {
      captured.dataCb = cb;
    },
    onClose(cb) {
      captured.closeCb = cb;
    },
    onResponseEnd() {},
  };

  return Object.assign(captured, { handle });
}

function webFetchInteractionQueryFrame(id: number): Buffer {
  if (id < 0 || id > 0x7f) throw new Error("test helper only encodes one-byte ids");
  // AgentServerMessage.interaction_query = field 7.
  // InteractionQuery.id = field 1, and Cursor's native WebFetch query is currently
  // an unknown field 9 in our generated proto.
  return Buffer.from(
    frameConnectMessage(new Uint8Array([0x3a, 0x06, 0x08, id, 0x4a, 0x02, 0x0a, 0x00])),
  );
}

function mcpToolCompletedErrorFrame(
  callId: string,
  toolName = "mcp_pi_fh_web_fetch",
  error = "Tool execution error",
): Buffer {
  return frameConnectMessage(
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: {
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, {
            message: {
              case: "toolCallCompleted",
              value: create(ToolCallCompletedUpdateSchema, {
                callId,
                modelCallId: "model-call-test",
                toolCall: {
                  tool: {
                    case: "mcpToolCall",
                    value: create(McpToolCallSchema, {
                      args: create(McpArgsSchema, {
                        name: toolName,
                        args: {},
                        toolCallId: callId,
                        providerIdentifier: "pi",
                        toolName,
                      }),
                      result: create(McpToolResultSchema, {
                        result: {
                          case: "error",
                          value: create(McpToolErrorSchema, { error }),
                        },
                      }),
                    }),
                  },
                },
              }),
            },
          }),
        },
      }),
    ),
  );
}

function decodeLastInteractionResponse(captured: { writes: Uint8Array[] }) {
  const responseFrame = captured.writes.at(-1);
  if (!responseFrame) throw new Error("expected at least one bridge write");
  const clientMessage = fromBinary(AgentClientMessageSchema, responseFrame.slice(5));
  expect(clientMessage.message.case).toBe("interactionResponse");
  if (clientMessage.message.case !== "interactionResponse") {
    throw new Error("expected interaction response");
  }
  return clientMessage.message.value as unknown as {
    id: number;
    $unknown?: Array<{ no: number; wireType: number; data: Uint8Array }>;
  };
}

async function waitForSilentBridgeReady(captured: ReturnType<typeof installSilentBridge>) {
  for (let i = 0; i < 10; i += 1) {
    if (captured.dataCb && captured.closeCb) return;
    await Promise.resolve();
  }
  throw new Error("silent bridge callbacks were not registered");
}

function makeStoredConversation(
  overrides: Partial<StoredConversation> = {},
): StoredConversation {
  return {
    conversationId: "conv-test",
    checkpoint: null,
    sessionScoped: false,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    ...overrides,
  };
}

function makeCompletedTurn(userText: string): ParsedTurn {
  return { userText, steps: [{ kind: "assistantText", text: "ok" }] };
}

describe("clearStoredCheckpoint cleanup of mid-pause state", () => {
  it("bridge handle write/end tolerate async EPIPE on child stdin during cleanup", async () => {
    class EpipeWritable extends Writable {
      _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        this.emit("error", err);
        callback();
      }
    }

    const proc = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      kill: () => boolean;
    };
    proc.stdin = new EpipeWritable();
    proc.stdout = new PassThrough();
    proc.kill = () => true;

    const handle = bridgeInternals.createBridgeHandleForChild(
      proc,
      { accessToken: "token", rpcPath: "/agent.v1.AgentService/Run" },
      () => undefined,
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(() => handle.write(new Uint8Array([1, 2, 3]))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => handle.end()).not.toThrow();
  });

  it("clears midPausePendingToolCalls when discardStaleCheckpointIfNeeded fires", () => {
    const stored = makeStoredConversation();
    const completedTurns = [makeCompletedTurn("t1")];

    commitStoredCheckpointMidPause(stored, new Uint8Array([1]), new Map(), completedTurns, [
      { toolCallId: "tc_a", toolName: "shell" },
    ]);
    expect(stored.midPausePendingToolCalls).toHaveLength(1);
    expect(stored.midPauseTurnCount).toBe(completedTurns.length);
    expect(stored.midPauseHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPauseRecordedAtMs).toEqual(expect.any(Number));

    // Trigger staleness via mismatched completedTurns count
    __testInternals.discardStaleCheckpointIfNeeded(stored, [], "r", "ck-clear");

    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBeUndefined();
    expect(stored.checkpointHistoryFingerprint).toBeUndefined();
    expect(stored.midPausePendingToolCalls).toBeUndefined();
    expect(stored.midPauseTurnCount).toBeUndefined();
    expect(stored.midPauseHistoryFingerprint).toBeUndefined();
    expect(stored.midPauseRecordedAtMs).toBeUndefined();
  });
});

describe("commitStoredCheckpointMidPause", () => {
  it("stores fingerprint of completedTurns only and records midPausePendingToolCalls", () => {
    const stored = makeStoredConversation();
    const checkpointBytes = new Uint8Array([1, 2, 3, 4]);
    const completedTurns = [makeCompletedTurn("hello"), makeCompletedTurn("world")];
    const pendingToolCalls = [
      { toolCallId: "call_1", toolName: "search" },
      { toolCallId: "call_2", toolName: "read_file" },
    ];

    commitStoredCheckpointMidPause(
      stored,
      checkpointBytes,
      new Map(),
      completedTurns,
      pendingToolCalls,
    );

    expect(stored.checkpoint).toBe(checkpointBytes);
    expect(stored.checkpointSource).toBe("upstream");
    expect(stored.checkpointTurnCount).toBe(completedTurns.length);
    expect(stored.checkpointHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPauseTurnCount).toBe(completedTurns.length);
    expect(stored.midPauseHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPauseRecordedAtMs).toEqual(expect.any(Number));
    expect(stored.midPausePendingToolCalls).toEqual([
      { toolCallId: "call_1", toolName: "search" },
      { toolCallId: "call_2", toolName: "read_file" },
    ]);
    // Ensure it's a defensive copy (not the same array reference)
    expect(stored.midPausePendingToolCalls).not.toBe(pendingToolCalls);
  });

  it("records metadata-only mid-pause state when no upstream checkpoint has arrived", () => {
    const stored = makeStoredConversation();
    const completedTurns = [makeCompletedTurn("hello")];
    const pendingToolCalls = [{ toolCallId: "call_no_checkpoint", toolName: "shell" }];

    const before = Date.now();
    commitStoredCheckpointMidPause(
      stored,
      null,
      new Map([["blob-a", new Uint8Array([1, 2, 3])]]),
      completedTurns,
      pendingToolCalls,
    );
    const after = Date.now();

    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointSource).toBe("absent");
    expect(stored.checkpointTurnCount).toBeUndefined();
    expect(stored.checkpointHistoryFingerprint).toBeUndefined();
    expect(stored.midPausePendingToolCalls).toEqual([
      { toolCallId: "call_no_checkpoint", toolName: "shell" },
    ]);
    expect(stored.midPauseTurnCount).toBe(completedTurns.length);
    expect(stored.midPauseHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPauseRecordedAtMs).toBeGreaterThanOrEqual(before);
    expect(stored.midPauseRecordedAtMs).toBeLessThanOrEqual(after);
    expect(stored.blobStore.get("blob-a")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("lostToolContinuationErrorBody includes message, type, code, hadStoredCheckpoint, and 8-char bridgeKeyPrefix", () => {
    const body = lostToolContinuationErrorBody({
      bridgeKey: "abcdef0123456789",
      hadStoredCheckpoint: true,
    });
    expect(body).toEqual({
      error: {
        message:
          "Cursor tool continuation was lost because the live upstream bridge is no longer available. Retry from before the tool call or start a new turn.",
        type: "invalid_state_error",
        code: "tool_continuation_lost",
        hadStoredCheckpoint: true,
        bridgeKeyPrefix: "abcdef01",
      },
    });
  });

  it("lostToolContinuationErrorBody reports hadStoredCheckpoint=false when no checkpoint existed", () => {
    const body = lostToolContinuationErrorBody({
      bridgeKey: "0123456789abcdef",
      hadStoredCheckpoint: false,
    });
    expect((body as { error: { hadStoredCheckpoint: boolean; bridgeKeyPrefix: string } }).error)
      .toMatchObject({ hadStoredCheckpoint: false, bridgeKeyPrefix: "01234567" });
  });

  it("lostToolContinuationErrorBody includes structured skipReason when supplied", () => {
    const body = lostToolContinuationErrorBody({
      bridgeKey: "0123456789abcdef",
      hadStoredCheckpoint: false,
      skipReason: "no_stored_conversation",
    });
    expect(body.error).toMatchObject({
      hadStoredCheckpoint: false,
      bridgeKeyPrefix: "01234567",
      skipReason: "no_stored_conversation",
    });
  });

  it("formatLostToolContinuationDiagnostic returns a [diagnostic: …] suffix usable for native writer.error messages", () => {
    const tail = formatLostToolContinuationDiagnostic({
      bridgeKey: "deadbeefcafef00d",
      hadStoredCheckpoint: true,
    });
    expect(tail).toBe("[diagnostic: hadStoredCheckpoint=true bridgeKeyPrefix=deadbeef]");
  });

  it("formatLostToolContinuationDiagnostic includes skipReason when supplied", () => {
    const tail = formatLostToolContinuationDiagnostic({
      bridgeKey: "deadbeefcafef00d",
      hadStoredCheckpoint: false,
      skipReason: "no_midpause_snapshot",
    });
    expect(tail).toBe(
      "[diagnostic: hadStoredCheckpoint=false bridgeKeyPrefix=deadbeef skipReason=no_midpause_snapshot]",
    );
  });

  it("default ACTIVE_BRIDGE_TTL_MS is 60 minutes; env override wins; non-numeric env falls back; min clamp at 1s", () => {
    expect(resolveActiveBridgeTtlMs(undefined)).toBe(60 * 60 * 1000);
    expect(resolveActiveBridgeTtlMs("")).toBe(60 * 60 * 1000);
    expect(resolveActiveBridgeTtlMs("120000")).toBe(120_000);
    expect(resolveActiveBridgeTtlMs("not-a-number")).toBe(60 * 60 * 1000);
    expect(resolveActiveBridgeTtlMs("500")).toBe(1_000); // existing min clamp
  });

  it("default stream idle timeout is 2 minutes; env override wins; invalid and negative values fall back; zero disables", () => {
    expect(__testInternals.resolveStreamIdleTimeoutMs(undefined)).toBe(2 * 60 * 1000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("")).toBe(2 * 60 * 1000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("   ")).toBe(2 * 60 * 1000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("120000")).toBe(120_000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("not-a-number")).toBe(2 * 60 * 1000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("-1")).toBe(2 * 60 * 1000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("0")).toBe(0);
    expect(__testInternals.resolveStreamIdleTimeoutMs("500")).toBe(1_000);
    expect(__testInternals.resolveStreamIdleTimeoutMs("1500.9")).toBe(1_500);
  });

  it("default resume idle timeout is 4 minutes; env override wins; invalid and negative values fall back; zero disables", () => {
    expect(__testInternals.resolveResumeIdleTimeoutMs(undefined)).toBe(4 * 60 * 1000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("")).toBe(4 * 60 * 1000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("   ")).toBe(4 * 60 * 1000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("120000")).toBe(120_000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("not-a-number")).toBe(4 * 60 * 1000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("-1")).toBe(4 * 60 * 1000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("0")).toBe(0);
    expect(__testInternals.resolveResumeIdleTimeoutMs("500")).toBe(1_000);
    expect(__testInternals.resolveResumeIdleTimeoutMs("1500.9")).toBe(1_500);
  });

  it("default stream idle retry count is 3; env override wins; invalid and negative values fall back; zero disables", () => {
    expect(__testInternals.resolveStreamIdleMaxRetries(undefined)).toBe(3);
    expect(__testInternals.resolveStreamIdleMaxRetries("")).toBe(3);
    expect(__testInternals.resolveStreamIdleMaxRetries("   ")).toBe(3);
    expect(__testInternals.resolveStreamIdleMaxRetries("5")).toBe(5);
    expect(__testInternals.resolveStreamIdleMaxRetries("not-a-number")).toBe(3);
    expect(__testInternals.resolveStreamIdleMaxRetries("-1")).toBe(3);
    expect(__testInternals.resolveStreamIdleMaxRetries("0")).toBe(0);
    expect(__testInternals.resolveStreamIdleMaxRetries("0.9")).toBe(1);
    expect(__testInternals.resolveStreamIdleMaxRetries("2.9")).toBe(2);
    expect(__testInternals.resolveStreamIdleMaxRetries("999")).toBe(10);
  });

  it("default mid-pause rebuild age cap is 15 minutes; env override wins; invalid and negative values fall back; min clamp at 1s", () => {
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs(undefined)).toBe(15 * 60 * 1000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("")).toBe(15 * 60 * 1000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("   ")).toBe(15 * 60 * 1000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("120000")).toBe(120_000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("not-a-number")).toBe(15 * 60 * 1000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("-1")).toBe(15 * 60 * 1000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("0")).toBe(1_000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("500")).toBe(1_000);
    expect(__testInternals.resolveMidPauseRebuildMaxAgeMs("1500.9")).toBe(1_500);
  });

  it("stream idle watchdog pauses during tool execution and rearms for resume continuations", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 1_000,
      onTimeout,
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("handleBridgeCloseMidPause commits the checkpoint when latestCheckpoint is present and stored exists", () => {
    const stored = makeStoredConversation();
    const checkpointBytes = new Uint8Array([42, 43, 44]);
    const completedTurns = [makeCompletedTurn("u1")];
    const pendingExecs = [
      { execId: "x1", execMsgId: 1, toolCallId: "tc_1", toolName: "shell", decodedArgs: "{}" },
    ];

    const result = handleBridgeCloseMidPause({
      stored,
      latestCheckpoint: checkpointBytes,
      blobStore: new Map(),
      completedTurns,
      pendingExecs,
    });

    expect(result.committed).toBe(true);
    expect(stored.checkpoint).toBe(checkpointBytes);
    expect(stored.midPausePendingToolCalls).toEqual([
      { toolCallId: "tc_1", toolName: "shell" },
    ]);
  });

  it("handleBridgeCloseMidPause records metadata-only state when latestCheckpoint is null", () => {
    const stored = makeStoredConversation();
    const completedTurns = [makeCompletedTurn("u1")];
    const result = handleBridgeCloseMidPause({
      stored,
      latestCheckpoint: null,
      blobStore: new Map([["blob-midpause", new Uint8Array([9])]]),
      completedTurns,
      pendingExecs: [
        { toolCallId: "tc_1", toolName: "shell" },
      ],
    });
    expect(result.committed).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointSource).toBe("absent");
    expect(stored.midPausePendingToolCalls).toEqual([
      { toolCallId: "tc_1", toolName: "shell" },
    ]);
    expect(stored.midPauseTurnCount).toBe(completedTurns.length);
    expect(stored.midPauseHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPauseRecordedAtMs).toEqual(expect.any(Number));
    expect(stored.blobStore.get("blob-midpause")).toEqual(new Uint8Array([9]));
  });

  it("handleBridgeCloseMidPause is a no-op when stored is undefined (no commit, no throw)", () => {
    const result = handleBridgeCloseMidPause({
      stored: undefined,
      latestCheckpoint: new Uint8Array([1]),
      blobStore: new Map(),
      completedTurns: [],
      pendingExecs: [],
    });
    expect(result.committed).toBe(false);
  });

  it("survives the staleness check when the recovery request re-parses the same completedTurns", () => {
    const stored = makeStoredConversation();
    const checkpointBytes = new Uint8Array([7, 8, 9]);
    const completedTurns = [makeCompletedTurn("first"), makeCompletedTurn("second")];

    commitStoredCheckpointMidPause(stored, checkpointBytes, new Map(), completedTurns, [
      { toolCallId: "call_a", toolName: "shell" },
    ]);

    __testInternals.discardStaleCheckpointIfNeeded(
      stored,
      completedTurns,
      "test-req",
      "test-conv-key",
    );

    expect(stored.checkpoint).toBe(checkpointBytes);
    expect(stored.midPausePendingToolCalls).toEqual([
      { toolCallId: "call_a", toolName: "shell" },
    ]);
  });
});

describe("capture-frame-trace.mjs CI guard", () => {
  const scriptPath = resolvePath(__dirname, "..", "scripts", "capture-frame-trace.mjs");
  let tmpOutDir: string | undefined;

  afterEach(() => {
    if (tmpOutDir) {
      rmSync(tmpOutDir, { recursive: true, force: true });
      tmpOutDir = undefined;
    }
  });

  it("refuses to run when CI=1 and exits 2", () => {
    tmpOutDir = mkdtempSync(joinPath(tmpdir(), "capture-frame-trace-"));
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--model", "gpt-5.4", "--out-dir", tmpOutDir],
      {
        env: { ...process.env, CI: "1" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("capture-frame-trace refuses to run under CI");
  });

  it("does not emit the CI refusal when --allow-ci is passed", () => {
    tmpOutDir = mkdtempSync(joinPath(tmpdir(), "capture-frame-trace-"));
    const fakeHome = mkdtempSync(joinPath(tmpdir(), "capture-frame-trace-home-"));
    try {
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--model", "gpt-5.4", "--allow-ci", "--out-dir", tmpOutDir],
        {
          // Override HOME (and USERPROFILE on Windows) so the auth-file fallback at ~/.pi/agent/auth.json
          // can never read a real token from the developer's or CI's machine.
          env: {
            ...process.env,
            CI: "1",
            CURSOR_ACCESS_TOKEN: "",
            HOME: fakeHome,
            USERPROFILE: fakeHome,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.stderr).not.toContain("capture-frame-trace refuses to run under CI");
      // With CI bypassed and no credentials available, the script must reach the token-fetch path and
      // exit non-zero with the documented "No Cursor access token found" diagnostic — proving the guard
      // was bypassed AND that no live Cursor request was issued.
      expect(result.stderr).toContain("No Cursor access token found");
      expect(result.status).toBe(1);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("emits --help cleanly when CI is unset, without invoking output", () => {
    const envCopy = { ...process.env };
    delete envCopy.CI;
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      env: { ...envCopy, CURSOR_ACCESS_TOKEN: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.stderr).not.toContain("capture-frame-trace refuses to run under CI");
    expect(result.status).toBe(0);
  });
});

describe("debugBase64ImageSummary", () => {
  it("hashes valid base64 input and does not set decodeError", () => {
    const summary = __testInternals.debugBase64ImageSummary("AAEC") as {
      base64Length: number;
      byteLength?: number;
      sha256?: string;
      decodeError?: boolean;
    };
    expect(summary.base64Length).toBe(4);
    expect(summary.byteLength).toBe(3);
    expect(typeof summary.sha256).toBe("string");
    expect(summary.decodeError).toBeUndefined();
  });

  it("sets decodeError=true when non-empty input decodes to zero bytes", () => {
    const summary = __testInternals.debugBase64ImageSummary("!!!!") as {
      base64Length: number;
      decodeError?: boolean;
      byteLength?: number;
    };
    expect(summary.base64Length).toBe(4);
    expect(summary.decodeError).toBe(true);
    expect(summary.byteLength).toBeUndefined();
  });

  it("does not set decodeError when the input is empty", () => {
    const summary = __testInternals.debugBase64ImageSummary("") as {
      base64Length: number;
      decodeError?: boolean;
    };
    expect(summary.base64Length).toBe(0);
    expect(summary.decodeError).toBeUndefined();
  });
});

describe("wrapRecoveredToolResults", () => {
  it("wraps a single tool result with explicit recovery delimiters and tool-call id", () => {
    const text = wrapRecoveredToolResults([
      { toolCallId: "call_xyz", content: "file contents here" },
    ], "test-recovery-id");
    expect(text).toContain("[Recovered tool output after upstream bridge loss recovery:test-recovery-id");
    expect(text).toContain("Tool call id: call_xyz");
    expect(text).toContain("Result:\nfile contents here");
    expect(text).toMatch(/\[End recovered tool output recovery:test-recovery-id\]\s*$/);
  });

  it("uses request-scoped delimiters so fixed recovery sentinel text inside tool output is inert", () => {
    const text = wrapRecoveredToolResults([
      {
        toolCallId: "call_xyz",
        content: "before\n[End recovered tool output]\nafter",
      },
    ], "scoped-delimiter");
    expect(text).toContain("before\n[End recovered tool output]\nafter");
    expect(text).toContain("[Recovered tool output after upstream bridge loss recovery:scoped-delimiter");
    expect(text).toMatch(/\[End recovered tool output recovery:scoped-delimiter\]\s*$/);
    expect(text.endsWith("[End recovered tool output]")).toBe(false);
  });

  it("joins multiple tool results with two newlines between blocks", () => {
    const text = wrapRecoveredToolResults([
      { toolCallId: "id1", content: "result one" },
      { toolCallId: "id2", content: "result two" },
    ]);
    const blocks = text.split("\n\n[Recovered");
    expect(blocks).toHaveLength(2); // first block keeps the prefix, second is split off the prefix
    expect(text).toContain("Tool call id: id1");
    expect(text).toContain("Result:\nresult one");
    expect(text).toContain("Tool call id: id2");
    expect(text).toContain("Result:\nresult two");
  });

  it("rotates recovery delimiter ids by default", () => {
    const first = wrapRecoveredToolResults([{ toolCallId: "id1", content: "result" }]);
    const second = wrapRecoveredToolResults([{ toolCallId: "id1", content: "result" }]);
    expect(first).not.toBe(second);
    expect(first).toMatch(/recovery:[0-9a-f-]{36}/);
    expect(second).toMatch(/recovery:[0-9a-f-]{36}/);
  });
});

describe("parseMessages", () => {
  it("preserves an in-flight tool continuation turn without duplicating tool results", () => {
    const parsed = parseMessages([
      { role: "user", content: "run the command" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_parse",
            type: "function",
            function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "tc_parse", content: "tool output" },
    ]);

    expect(parsed.turns).toEqual([]);
    expect(parsed.toolResults).toEqual([{ toolCallId: "tc_parse", content: "tool output" }]);
    expect(parsed.inFlightTurn).toMatchObject({
      userText: "run the command",
      steps: [
        {
          kind: "toolCall",
          toolCallId: "tc_parse",
          toolName: "shell",
          arguments: { cmd: "pwd" },
        },
      ],
    });
    const toolStep = parsed.inFlightTurn?.steps[0];
    expect(toolStep?.kind).toBe("toolCall");
    if (toolStep?.kind !== "toolCall") throw new Error("expected tool call");
    expect(toolStep.result).toBeUndefined();
  });
});

describe("full-history rebuild image handling", () => {
  it("attaches tool-result images to the rebuilt recovery user message", () => {
    const recoveredImages = __testInternals.collectToolResultImages([
      {
        toolCallId: "tc_image",
        content: "image output",
        images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" }],
      },
    ]);

    const payload = buildCursorRequest({
      conversationId: "conv-image-rebuild",
      modelId: "gpt-5.4",
      systemPrompt: "system",
      userText: "recovered text",
      userImages: recoveredImages,
      turns: [],
      checkpoint: null,
      existingBlobStore: new Map(),
    });

    const debug = __testInternals.decodeRequestForTests(payload.requestBody);
    expect(debug.selectedImages).toHaveLength(1);
    expect(debug.selectedImages[0]).toMatchObject({ byteLength: 4, mimeType: "image/png" });
  });
});

describe("planRecovery", () => {
  const completedTurns = [makeCompletedTurn("hello")];
  const makeInFlightTurn = (toolCallId = "x"): ParsedTurn => ({
    userText: "run a tool",
    steps: [
      {
        kind: "toolCall",
        toolCallId,
        toolName: "shell",
        arguments: { cmd: "pwd" },
      },
    ],
  });

  it("returns kind=skip reason=no_stored_conversation when stored is undefined; hadStoredCheckpoint=false", () => {
    const decision = planRecovery({
      stored: undefined,
      toolResults: [{ toolCallId: "x", content: "y" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck1",
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "no_stored_conversation",
      hadStoredCheckpoint: false,
    });
  });

  it("returns kind=skip reason=no_midpause_snapshot when stored exists but has no checkpoint metadata", () => {
    const decision = planRecovery({
      stored: makeStoredConversation(),
      toolResults: [{ toolCallId: "x", content: "y" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck2",
    });
    expect(decision.kind).toBe("skip");
    expect(decision).toMatchObject({ reason: "no_midpause_snapshot", hadStoredCheckpoint: false });
  });

  it("returns kind=rebuild_full_history from metadata-only mid-pause state when ids and history match", () => {
    const stored = makeStoredConversation({ conversationId: "conv-rebuild" });
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_rebuild", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_rebuild", content: "tool output goes here" }],
      completedTurns,
      inFlightTurn: makeInFlightTurn("tc_rebuild"),
      requestId: "r1",
      convKey: "ck-rebuild",
    });

    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind !== "rebuild_full_history") throw new Error("expected rebuild");
    expect(decision.conversationId).toBe("conv-rebuild");
    expect(decision.completedTurns).toEqual(completedTurns);
    expect(decision.inFlightTurn.steps).toHaveLength(1);
    const step = decision.inFlightTurn.steps[0];
    expect(step.kind).toBe("toolCall");
    if (step.kind !== "toolCall") throw new Error("expected tool call");
    expect(step.result).toBeUndefined();
    expect(decision.rebuildReason).toBe("no_checkpoint");
    expect(decision.wrappedText).toContain("Tool call id: tc_rebuild");
    expect(decision.wrappedText).toContain("Result:\ntool output goes here");
  });

  it("preserves synthesized_after_idle as the rebuild reason for idle retry telemetry", () => {
    const stored = makeStoredConversation({ conversationId: "conv-idle-rebuild" });
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_idle_rebuild", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_idle_rebuild", content: "idle output" }],
      completedTurns,
      inFlightTurn: makeInFlightTurn("tc_idle_rebuild"),
      rebuildReason: "synthesized_after_idle",
      requestId: "r1",
      convKey: "ck-idle-rebuild",
    });

    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind !== "rebuild_full_history") throw new Error("expected rebuild");
    expect(decision.rebuildReason).toBe("synthesized_after_idle");
  });

  it("rejects metadata-only rebuild when completed-turn count mismatches and clears metadata", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_count", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_count", content: "output" }],
      completedTurns: [],
      inFlightTurn: makeInFlightTurn("tc_count"),
      requestId: "r1",
      convKey: "ck-count",
    });

    expect(decision).toMatchObject({
      kind: "skip",
      reason: "midpause_turn_count_mismatch",
    });
    expect(stored.midPausePendingToolCalls).toBeUndefined();
    expect(stored.midPauseTurnCount).toBeUndefined();
    expect(stored.midPauseHistoryFingerprint).toBeUndefined();
    expect(stored.midPauseRecordedAtMs).toBeUndefined();
  });

  it("rejects metadata-only rebuild when completed-history fingerprint mismatches and clears metadata", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_fingerprint", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_fingerprint", content: "output" }],
      completedTurns: [makeCompletedTurn("different-history")],
      inFlightTurn: makeInFlightTurn("tc_fingerprint"),
      requestId: "r1",
      convKey: "ck-fingerprint",
    });

    expect(decision).toMatchObject({
      kind: "skip",
      reason: "midpause_history_fingerprint_mismatch",
    });
    expect(stored.midPausePendingToolCalls).toBeUndefined();
  });

  it("rejects stale metadata-only rebuilds and clears metadata", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_stale", toolName: "shell" },
    ]);
    stored.midPauseRecordedAtMs = Date.now() - 16 * 60 * 1000;

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_stale", content: "output" }],
      completedTurns,
      inFlightTurn: makeInFlightTurn("tc_stale"),
      requestId: "r1",
      convKey: "ck-stale",
    });

    expect(decision).toMatchObject({
      kind: "skip",
      reason: "midpause_metadata_stale",
    });
    expect(stored.midPausePendingToolCalls).toBeUndefined();
  });

  it("rejects metadata-only rebuilds when the request has no in-flight tool continuation", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_no_inflight", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_no_inflight", content: "output" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck-no-inflight",
    });

    expect(decision).toMatchObject({
      kind: "skip",
      reason: "no_inflight_tool_continuation",
    });
    expect(stored.midPausePendingToolCalls).toHaveLength(1);
  });

  it("rejects metadata-only rebuilds from a different pi session", () => {
    const stored = makeStoredConversation({
      sessionScoped: true,
      sessionId: "session-a",
    });
    commitStoredCheckpointMidPause(stored, null, new Map(), completedTurns, [
      { toolCallId: "tc_session", toolName: "shell" },
    ]);

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "tc_session", content: "output" }],
      completedTurns,
      inFlightTurn: makeInFlightTurn("tc_session"),
      sessionId: "session-b",
      requestId: "r1",
      convKey: "ck-session",
    });

    expect(decision).toMatchObject({
      kind: "skip",
      reason: "session_mismatch",
    });
  });

  it("returns kind=skip reason=stale_checkpoint with hadStoredCheckpoint=true (snapshot before discard)", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(
      stored,
      new Uint8Array([1]),
      new Map(),
      completedTurns,
      [{ toolCallId: "x", toolName: "shell" }],
    );
    // Recovery request only carries 0 completed turns, so the staleness check fires.
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "x", content: "y" }],
      completedTurns: [],
      requestId: "r1",
      convKey: "ck3",
    });
    expect(decision).toMatchObject({
      kind: "skip",
      reason: "stale_checkpoint",
      hadStoredCheckpoint: true,
    });
    expect(stored.checkpoint).toBeNull(); // discardStaleCheckpointIfNeeded actually discarded it
  });

  it("returns kind=skip reason=pending_tool_call_mismatch when incoming ids contain extras", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(
      stored,
      new Uint8Array([1]),
      new Map(),
      completedTurns,
      [{ toolCallId: "expected_id", toolName: "shell" }],
    );
    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "expected_id", content: "ok" },
        { toolCallId: "extra_id", content: "extra" },
      ],
      completedTurns,
      requestId: "r1",
      convKey: "ck4",
    });
    expect(decision).toMatchObject({
      kind: "skip",
      reason: "pending_tool_call_mismatch",
      hadStoredCheckpoint: true,
      expected: ["expected_id"],
      received: ["expected_id", "extra_id"],
    });
  });

  it("returns kind=skip reason=pending_tool_call_mismatch when incoming ids are missing", () => {
    const stored = makeStoredConversation();
    commitStoredCheckpointMidPause(
      stored,
      new Uint8Array([1]),
      new Map(),
      completedTurns,
      [
        { toolCallId: "id_a", toolName: "shell" },
        { toolCallId: "id_b", toolName: "read" },
      ],
    );
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "id_a", content: "ok" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck5",
    });
    expect(decision).toMatchObject({
      kind: "skip",
      reason: "pending_tool_call_mismatch",
      hadStoredCheckpoint: true,
    });
  });

  it("returns kind=skip reason=pending_tool_call_mismatch when stored pending set is empty but incoming is non-empty", () => {
    const stored = makeStoredConversation({
      checkpoint: new Uint8Array([1]),
      checkpointTurnCount: completedTurns.length,
      checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns(completedTurns),
    });
    // Note: midPausePendingToolCalls is undefined.
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "x", content: "y" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck6",
    });
    expect(decision).toMatchObject({
      kind: "skip",
      reason: "pending_tool_call_mismatch",
      hadStoredCheckpoint: true,
    });
  });

  it("returns kind=recover with the wrapped user text when ids match exactly", () => {
    const stored = makeStoredConversation();
    const checkpointBytes = new Uint8Array([42]);
    commitStoredCheckpointMidPause(stored, checkpointBytes, new Map(), completedTurns, [
      { toolCallId: "match_id", toolName: "shell" },
    ]);
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "match_id", content: "tool output goes here" }],
      completedTurns,
      requestId: "r1",
      convKey: "ck7",
    });
    expect(decision.kind).toBe("recover");
    if (decision.kind !== "recover") throw new Error("expected recover");
    expect(decision.hadStoredCheckpoint).toBe(true);
    expect(decision.checkpoint).toBe(checkpointBytes);
    expect(decision.conversationId).toBe(stored.conversationId);
    expect(decision.wrappedText).toContain("Tool call id: match_id");
    expect(decision.wrappedText).toContain("Result:\ntool output goes here");
  });
});

describe("SSE /v1/chat/completions integration: lost-continuation error body", () => {
  async function postChat(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    return { status: res.status, json: parsed };
  }

  it("returns 409 with hadStoredCheckpoint=false and 8-char bridgeKeyPrefix when no stored checkpoint exists", async () => {
    const port = await startProxy(async () => "test-token");
    const sessionId = "sess-no-checkpoint-1";
    const requestBody = {
      model: "gpt-5.4",
      pi_session_id: sessionId,
      messages: [
        { role: "user" as const, content: "hello" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            { id: "tc_a", type: "function" as const, function: { name: "shell", arguments: "{}" } },
          ],
        },
        { role: "tool" as const, tool_call_id: "tc_a", content: "ok" },
      ],
      stream: true,
    };

    const result = await postChat(port, requestBody);
    expect(result.status).toBe(409);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body.error).toMatchObject({
      message:
        "Cursor tool continuation was lost because the live upstream bridge is no longer available. Retry from before the tool call or start a new turn.",
      type: "invalid_state_error",
      code: "tool_continuation_lost",
      hadStoredCheckpoint: false,
    });
    expect(body.error?.bridgeKeyPrefix).toMatch(/^[0-9a-f]{8}$/);
    const expectedPrefix = deriveBridgeKey(requestBody.messages, sessionId).slice(0, 8);
    expect(body.error?.bridgeKeyPrefix).toBe(expectedPrefix);
  });

  it("returns 409 with hadStoredCheckpoint=true when stored checkpoint exists but is stale", async () => {
    const port = await startProxy(async () => "test-token");
    const sessionId = "sess-stale-1";
    const requestBody = {
      model: "gpt-5.4",
      pi_session_id: sessionId,
      messages: [
        { role: "user" as const, content: "hello" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            { id: "tc_a", type: "function" as const, function: { name: "shell", arguments: "{}" } },
          ],
        },
        { role: "tool" as const, tool_call_id: "tc_a", content: "ok" },
      ],
      stream: true,
    };
    const convKey = deriveConversationKey(requestBody.messages, sessionId);
    // Pre-seed conversationStates with a checkpoint claiming a different completedTurns count
    // (so discardStaleCheckpointIfNeeded fires on the recovery path).
    __testInternals.conversationStates.set(convKey, {
      conversationId: "synthetic-conv-id",
      checkpoint: new Uint8Array([1, 2, 3]),
      checkpointTurnCount: 99, // mismatch — the request parses 0 completed turns
      checkpointHistoryFingerprint: "synthetic-fingerprint",
      midPausePendingToolCalls: [{ toolCallId: "tc_a", toolName: "shell" }],
      sessionScoped: true,
      sessionId,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    });

    const result = await postChat(port, requestBody);
    expect(result.status).toBe(409);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body.error).toMatchObject({
      type: "invalid_state_error",
      code: "tool_continuation_lost",
      hadStoredCheckpoint: true,
    });
  });

  it("when recovery succeeds, the spawned bridge receives a request whose conversationState equals the stored checkpoint and whose userMessage contains the wrapped tool-result text", async () => {
    // We pre-seed an in-process StoredConversation with a fresh checkpoint that
    // matches the recovery request's parsed completedTurns and pending tool-call ids.
    // Then we install a mock bridge factory that captures the request bytes and
    // immediately fires onClose(0) so the SSE response settles.
    const checkpointBytes = new Uint8Array([0x0a, 0x00]); // valid empty ConversationStateStructure
    const sessionId = "sess-recover-1";
    const requestBody = {
      model: "gpt-5.4",
      pi_session_id: sessionId,
      messages: [
        { role: "user" as const, content: "hello" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "tc_match",
              type: "function" as const,
              function: { name: "shell", arguments: "{}" },
            },
          ],
        },
        { role: "tool" as const, tool_call_id: "tc_match", content: "the tool output" },
      ],
      stream: true,
    };
    const convKey = deriveConversationKey(requestBody.messages, sessionId);
    __testInternals.conversationStates.set(convKey, {
      conversationId: "synthetic-conv-id",
      checkpoint: checkpointBytes,
      checkpointTurnCount: 0,
      checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns([]),
      midPausePendingToolCalls: [{ toolCallId: "tc_match", toolName: "shell" }],
      sessionScoped: true,
      sessionId,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    });

    const captured: { firstWrite: Uint8Array | null; closeCb: ((code: number) => void) | null } = {
      firstWrite: null,
      closeCb: null,
    };
    setBridgeFactoryForTests((_options) => {
      let alive = true;
      const handle: BridgeHandle = {
        proc: { kill: () => true },
        get alive() {
          return alive;
        },
        write(data: Uint8Array) {
          if (!captured.firstWrite) {
            captured.firstWrite = new Uint8Array(data);
            // Fire close after the first write (the request payload) so the SSE
            // response settles cleanly with code=0 (no upstream error).
            queueMicrotask(() => {
              alive = false;
              captured.closeCb?.(0);
            });
          }
        },
        end() {},
        onData(_cb) {},
        onClose(cb) {
          captured.closeCb = cb;
        },
        onResponseEnd() {},
      };
      return handle;
    });

    const port = await startProxy(async () => "test-token");
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    // Drain the SSE body to make sure the bridge close completes
    await res.text();

    expect(res.status).toBe(200);
    expect(captured.firstWrite).not.toBeNull();
    // Strip the 5-byte Connect frame prefix (flags + uint32 length).
    const framed = captured.firstWrite!;
    expect(framed.length).toBeGreaterThan(5);
    const requestBytes = framed.slice(5);
    const clientMessage = fromBinary(AgentClientMessageSchema, requestBytes);
    expect(clientMessage.message.case).toBe("runRequest");
    if (clientMessage.message.case !== "runRequest") throw new Error("expected runRequest");
    const runRequest = clientMessage.message.value;
    // The conversationState SHOULD have been built from the stored checkpoint
    // (not rebuilt from turns). For our minimal checkpoint bytes, this means the
    // conversationState is the empty/default ConversationStateStructure.
    expect(runRequest.conversationState).toBeDefined();
    const conv = runRequest.conversationState as ConversationStateStructure;
    expect(conv.turns).toEqual([]); // empty per our checkpoint
    expect(conv.clientName).toBe(""); // default value when decoded from empty bytes
    expect(runRequest.conversationId).toBe("synthetic-conv-id");
    // The userMessage must carry the wrapped text. Its content travels via blob
    // reference, but the wrapped text shows up in the encoded action's userMessage
    // path. Easier assertion: encode the request and search for our recoverable marker.
    const allBytes = Buffer.from(requestBytes).toString("utf8");
    expect(allBytes).toContain("Recovered tool output after upstream bridge loss");
    expect(allBytes).toContain("Tool call id: tc_match");
    expect(allBytes).toContain("the tool output");
  });

  it("native streamSimple: tool result with no stored checkpoint returns an AssistantMessage with stopReason=error and the diagnostic suffix in errorMessage", async () => {
    const streamSimple = createCursorNativeStream({
      getAccessToken: async () => "test-token",
    });
    const model: Model<"cursor-native"> = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "cursor-native",
      provider: "cursor",
      baseUrl: "https://api2.cursor.sh",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const sessionId = "sess-native-no-checkpoint-1";
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_native", name: "shell", arguments: {} },
          ],
          api: "cursor-native",
          provider: "cursor",
          model: "gpt-5.4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc_native",
          toolName: "shell",
          content: [{ type: "text", text: "the result" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const stream = streamSimple(model, context, { sessionId });
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "Cursor tool continuation was lost because the live upstream bridge is no longer available",
    );
    expect(result.errorMessage).toMatch(
      /\[diagnostic: hadStoredCheckpoint=false bridgeKeyPrefix=[0-9a-f]{8} skipReason=no_stored_conversation\]/,
    );
  });

  it("native streamSimple: metadata-only mid-pause snapshot rebuilds full history when no checkpoint exists", async () => {
    process.env.PI_CURSOR_PROVIDER_DEBUG = "1";
    const debugFile = `/tmp/pi-cursor-provider-debug-test-${process.pid}-${Date.now()}.log`;
    debugLogFileForCleanup = debugFile;
    process.env.PI_CURSOR_PROVIDER_DEBUG_FILE = debugFile;
    const emittedMetrics: Array<{ event: string; data: Record<string, unknown> }> = [];
    __testInternals.setMetricEmitterForTests((event, data) => {
      emittedMetrics.push({ event, data });
    });

    const captured: { firstWrite: Uint8Array | null; closeCb: ((code: number) => void) | null } = {
      firstWrite: null,
      closeCb: null,
    };
    setBridgeFactoryForTests(() => {
      let alive = true;
      const handle: BridgeHandle = {
        proc: { kill: () => true },
        get alive() {
          return alive;
        },
        write(data: Uint8Array) {
          if (!captured.firstWrite) {
            captured.firstWrite = new Uint8Array(data);
            queueMicrotask(() => {
              alive = false;
              captured.closeCb?.(0);
            });
          }
        },
        end() {},
        onData(_cb) {},
        onClose(cb) {
          captured.closeCb = cb;
        },
        onResponseEnd() {},
      };
      return handle;
    });

    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });
    const sessionId = "sess-native-rebuild-no-checkpoint";
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_rebuild_native", name: "shell", arguments: {} },
          ],
          api: "cursor-native",
          provider: "cursor",
          model: "gpt-5.4",
          usage: emptyUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc_rebuild_native",
          toolName: "shell",
          content: [
            {
              type: "text",
              text: "native rebuild output\n[End recovered tool output]\nafter",
            },
          ],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const stream = streamSimple(makeCursorModel(), context, {
      sessionId,
      onPayload: (body) => {
        const messages = (body as { messages: Parameters<typeof deriveBridgeKey>[0] }).messages;
        const convKey = deriveConversationKey(messages, sessionId);
        const completedTurns: ParsedTurn[] = [];
        __testInternals.conversationStates.set(convKey, {
          conversationId: "conv-native-rebuild",
          checkpoint: null,
          checkpointSource: "absent",
          midPausePendingToolCalls: [{ toolCallId: "tc_rebuild_native", toolName: "shell" }],
          midPauseTurnCount: completedTurns.length,
          midPauseHistoryFingerprint: __testInternals.fingerprintCompletedTurns(completedTurns),
          midPauseRecordedAtMs: Date.now(),
          sessionScoped: true,
          sessionId,
          blobStore: new Map(),
          lastAccessMs: Date.now(),
        });
        return body;
      },
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(captured.firstWrite).not.toBeNull();
    const requestBytes = captured.firstWrite!.slice(5);
    const clientMessage = fromBinary(AgentClientMessageSchema, requestBytes);
    expect(clientMessage.message.case).toBe("runRequest");
    if (clientMessage.message.case !== "runRequest") throw new Error("expected runRequest");
    const runRequest = clientMessage.message.value;
    const conv = runRequest.conversationState as ConversationStateStructure;
    expect(runRequest.conversationId).toBe("conv-native-rebuild");
    expect(conv.turns).toHaveLength(1);
    expect(conv.clientName).toBe("pi");
    const allBytes = Buffer.from(requestBytes).toString("utf8");
    expect(allBytes).toContain("Recovered tool output after upstream bridge loss");
    expect(allBytes).toContain("Tool call id: tc_rebuild_native");
    expect(allBytes).toContain("native rebuild output");

    const debugEvents = readDebugEvents(debugFile);
    const rebuildLog = debugEvents.find((event) => event.event === "native.rebuild_full_history");
    expect(rebuildLog).toMatchObject({
      bridgeKeyPrefix: expect.stringMatching(/^[0-9a-f]{8}$/),
      modelId: "gpt-5.4",
      rebuildReason: "no_checkpoint",
      completedTurnCount: 0,
      inFlightTurnHasImages: false,
      toolResultCount: 1,
      sentinelInjectionDetected: true,
    });
    expect(rebuildLog).not.toHaveProperty("bridgeKey");
    const metricLog = debugEvents.find(
      (event) => event.event === "metric.cursor_provider.rebuild_full_history",
    );
    expect(metricLog).toMatchObject({
      metric: "cursor_provider.rebuild_full_history",
      reason: "no_checkpoint",
      model: "gpt-5.4",
      count: 1,
    });
    expect(emittedMetrics).toEqual([
      {
        event: "metric.cursor_provider.rebuild_full_history",
        data: expect.objectContaining({
          metric: "cursor_provider.rebuild_full_history",
          reason: "no_checkpoint",
          model: "gpt-5.4",
          count: 1,
        }),
      },
    ]);
  });

  it("native streamSimple: silent upstream Cursor stream returns an idle timeout error instead of hanging", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), { sessionId: "sess-idle-1" });
    const resultPromise = stream.result();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Cursor stream idle timeout after 1000ms without upstream data",
    );
    expect(captured.ended).toBe(true);
  });

  it("native streamSimple: outbound heartbeats do not reset the upstream stream idle timeout", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "6000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), { sessionId: "sess-idle-2" });
    const resultPromise = stream.result();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(captured.writes.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Cursor stream idle timeout after 6000ms without upstream data",
    );
  });

  it("native streamSimple: retries a silent upstream stream three times before failing", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    const attempts = installRetryBridgeFactory();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), { sessionId: "sess-idle-retry-fail" });
    const resultPromise = stream.result();

    await vi.advanceTimersByTimeAsync(4_000);
    const result = await resultPromise;

    expect(attempts).toHaveLength(4);
    expect(attempts.every((attempt) => attempt.ended)).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Cursor stream idle timeout after 1000ms without upstream data over 4 attempts (3 retries)",
    );
  });

  it("native streamSimple: idle retry stays in the same stream and succeeds when a later attempt responds", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    const attempts = installRetryBridgeFactory({ succeedOnAttempt: 4 });
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), { sessionId: "sess-idle-retry-success" });
    const resultPromise = stream.result();

    await vi.advanceTimersByTimeAsync(3_000);
    const result = await resultPromise;

    expect(attempts).toHaveLength(4);
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
  });

  it("native streamSimple: idle retry after tool-result continuation recovers from checkpoint in the same stream", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS = "1000";
    const active = makeManualSilentBridge();
    const recoveryAttempts = installRetryBridgeFactory({ succeedOnAttempt: 1 });
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });
    const sessionId = "sess-idle-tool-retry";
    let bridgeKey = "";
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_retry", name: "shell", arguments: {} },
          ],
          api: "cursor-native",
          provider: "cursor",
          model: "gpt-5.4",
          usage: emptyUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc_retry",
          toolName: "shell",
          content: [{ type: "text", text: "tool output for retry" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const stream = streamSimple(makeCursorModel(), context, {
      sessionId,
      onPayload: (body) => {
        const messages = (body as { messages: Parameters<typeof deriveBridgeKey>[0] }).messages;
        bridgeKey = deriveBridgeKey(messages, sessionId);
        const convKey = deriveConversationKey(messages, sessionId);
        __testInternals.conversationStates.set(convKey, {
          conversationId: "conv-tool-retry",
          checkpoint: new Uint8Array([0x0a, 0x00]),
          checkpointTurnCount: 0,
          checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns([]),
          midPausePendingToolCalls: [{ toolCallId: "tc_retry", toolName: "shell" }],
          sessionScoped: true,
          sessionId,
          blobStore: new Map(),
          lastAccessMs: Date.now(),
        });
        __testInternals.activeBridges.set(bridgeKey, {
          bridge: active.handle,
          heartbeatTimer: setInterval(() => undefined, 5_000),
          blobStore: new Map(),
          mcpTools: [],
          pendingExecs: [
            {
              execId: "exec-retry",
              execMsgId: 7,
              toolCallId: "tc_retry",
              toolName: "shell",
              decodedArgs: "{}",
            },
          ],
          currentTurn: {
            userText: "hello",
            steps: [
              {
                kind: "toolCall",
                toolCallId: "tc_retry",
                toolName: "shell",
                arguments: {},
              },
            ],
          },
        });
        return body;
      },
    });
    const resultPromise = stream.result();

    await waitForSilentBridgeReady(active);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(active.ended).toBe(true);
    expect(recoveryAttempts).toHaveLength(1);
    expect(__testInternals.activeBridges.has(bridgeKey)).toBe(false);
    expect(result.stopReason).toBe("stop");
    const recoveredRequest = Buffer.from(recoveryAttempts[0]!.writes[0]!).toString("utf8");
    expect(recoveredRequest).toContain("Recovered tool output after upstream bridge loss");
    expect(recoveredRequest).toContain("tool output for retry");
  });

  it("native streamSimple: failed resume recovery falls through to retry-budget error handling", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "1";
    process.env.PI_CURSOR_PROVIDER_DEBUG = "1";
    const debugFile = `/tmp/pi-cursor-provider-debug-test-${process.pid}-${Date.now()}.log`;
    debugLogFileForCleanup = debugFile;
    process.env.PI_CURSOR_PROVIDER_DEBUG_FILE = debugFile;

    const active = makeManualSilentBridge();
    const fallbackAttempts = installRetryBridgeFactory({ succeedOnAttempt: 1 });
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });
    const sessionId = "sess-idle-tool-retry-throws";
    const throwingBlobStore = {
      [Symbol.iterator]() {
        throw new Error("forced blob store failure");
      },
    } as unknown as Map<string, Uint8Array>;
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc_retry_throw", name: "shell", arguments: {} }],
          api: "cursor-native",
          provider: "cursor",
          model: "gpt-5.4",
          usage: emptyUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc_retry_throw",
          toolName: "shell",
          content: [{ type: "text", text: "tool output for thrown retry" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const stream = streamSimple(makeCursorModel(), context, {
      sessionId,
      onPayload: (body) => {
        const messages = (body as { messages: Parameters<typeof deriveBridgeKey>[0] }).messages;
        const bridgeKey = deriveBridgeKey(messages, sessionId);
        const convKey = deriveConversationKey(messages, sessionId);
        __testInternals.conversationStates.set(convKey, {
          conversationId: "conv-tool-retry-throws",
          checkpoint: new Uint8Array([0x0a, 0x00]),
          checkpointTurnCount: 0,
          checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns([]),
          midPausePendingToolCalls: [{ toolCallId: "tc_retry_throw", toolName: "shell" }],
          sessionScoped: true,
          sessionId,
          blobStore: throwingBlobStore,
          lastAccessMs: Date.now(),
        });
        __testInternals.activeBridges.set(bridgeKey, {
          bridge: active.handle,
          heartbeatTimer: setInterval(() => undefined, 5_000),
          blobStore: new Map(),
          mcpTools: [],
          pendingExecs: [
            {
              execId: "exec-retry-throws",
              execMsgId: 8,
              toolCallId: "tc_retry_throw",
              toolName: "shell",
              decodedArgs: "{}",
            },
          ],
          currentTurn: {
            userText: "hello",
            steps: [
              {
                kind: "toolCall",
                toolCallId: "tc_retry_throw",
                toolName: "shell",
                arguments: {},
              },
            ],
          },
        });
        return body;
      },
    });
    const resultPromise = stream.result();

    await waitForSilentBridgeReady(active);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Cursor stream idle timeout after 1000ms without upstream data over 2 attempts (1 retry)",
    );
    expect(fallbackAttempts).toHaveLength(0);
    const debugEvents = readDebugEvents(debugFile) as Array<{ event: string; message?: string }>;
    expect(debugEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "native.stream.idle_recovery_before_retry_error",
        "native.stream.idle_retry_error",
      ]),
    );
    expect(
      debugEvents.some(
        (event) =>
          event.event === "native.stream.idle_recovery_before_retry_error" &&
          event.message === "forced blob store failure",
      ),
    ).toBe(true);
  });

  it("native streamSimple: bridge close clears idle watchdog and heartbeat timers", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), { sessionId: "sess-idle-close" });
    const resultPromise = stream.result();
    await waitForSilentBridgeReady(captured);

    captured.closeCb?.(0);
    const result = await resultPromise;

    expect(result.stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("native streamSimple: tokenDelta-only updates after tool-result resume trigger recovery before retry budget", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";

    const active = makeManualSilentBridge();
    const recoveryAttempts = installRetryBridgeFactory({ succeedOnAttempt: 1 });

    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });
    const sessionId = "sess-tokendelta-resume";
    let bridgeKey = "";
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_tokendelta", name: "shell", arguments: {} },
          ],
          api: "cursor-native",
          provider: "cursor",
          model: "gpt-5.4",
          usage: emptyUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc_tokendelta",
          toolName: "shell",
          content: [{ type: "text", text: "tool output" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const stream = streamSimple(makeCursorModel(), context, {
      sessionId,
      onPayload: (body) => {
        const messages = (body as { messages: Parameters<typeof deriveBridgeKey>[0] }).messages;
        bridgeKey = deriveBridgeKey(messages, sessionId);
        const convKey = deriveConversationKey(messages, sessionId);
        __testInternals.conversationStates.set(convKey, {
          conversationId: "conv-tokendelta",
          checkpoint: new Uint8Array([0x0a, 0x00]),
          checkpointTurnCount: 0,
          checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns([]),
          midPausePendingToolCalls: [{ toolCallId: "tc_tokendelta", toolName: "shell" }],
          sessionScoped: true,
          sessionId,
          blobStore: new Map(),
          lastAccessMs: Date.now(),
        });
        __testInternals.activeBridges.set(bridgeKey, {
          bridge: active.handle,
          heartbeatTimer: setInterval(() => undefined, 5_000),
          blobStore: new Map(),
          mcpTools: [],
          pendingExecs: [
            {
              execId: "exec-tokendelta",
              execMsgId: 9,
              toolCallId: "tc_tokendelta",
              toolName: "shell",
              decodedArgs: "{}",
            },
          ],
          currentTurn: {
            userText: "hello",
            steps: [
              {
                kind: "toolCall",
                toolCallId: "tc_tokendelta",
                toolName: "shell",
                arguments: {},
              },
            ],
          },
        });
        return body;
      },
    });
    const resultPromise = stream.result();
    let settled = false;
    let result: Awaited<typeof resultPromise> | undefined;
    void resultPromise.then((r) => {
      result = r;
      settled = true;
    });

    await waitForSilentBridgeReady(active);

    const tokenDeltaFrame = frameConnectMessage(
      toBinary(
        AgentServerMessageSchema,
        create(AgentServerMessageSchema, {
          message: {
            case: "interactionUpdate",
            value: create(InteractionUpdateSchema, {
              message: {
                case: "tokenDelta",
                value: create(TokenDeltaUpdateSchema, { tokens: 1 }),
              },
            }),
          },
        }),
      ),
    );

    // Emit tokenDelta-only frames every 250ms for 1500ms — well past the 1000ms idle timeout.
    // Today this stream stalls forever because bridge.onData resets the watchdog on every chunk
    // including tokenDelta updates that produce no observable progress. After the fix, the
    // watchdog only resets on real progress (text/exec/checkpoint/kv) and fires at 1000ms.
    for (let elapsed = 0; elapsed < 1500; elapsed += 250) {
      active.dataCb?.(tokenDeltaFrame);
      await vi.advanceTimersByTimeAsync(250);
      if (settled) break;
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(result?.stopReason).toBe("stop");
    expect(recoveryAttempts).toHaveLength(1);
    expect(__testInternals.activeBridges.has(bridgeKey)).toBe(false);
    expect(active.ended).toBe(true);
  });

  it("native streamSimple: textDelta updates reset the idle watchdog (no false timeout during real progress)", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {
      sessionId: "sess-textdelta-progress",
    });
    const resultPromise = stream.result();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await waitForSilentBridgeReady(captured);

    const textDeltaFrame = frameConnectMessage(
      toBinary(
        AgentServerMessageSchema,
        create(AgentServerMessageSchema, {
          message: {
            case: "interactionUpdate",
            value: create(InteractionUpdateSchema, {
              message: {
                case: "textDelta",
                // TextDelta uses a string field; create with a plain object.
                value: { text: "tick" } as never,
              },
            }),
          },
        }),
      ),
    );

    for (let elapsed = 0; elapsed < 1500; elapsed += 250) {
      captured.dataCb?.(textDeltaFrame);
      await vi.advanceTimersByTimeAsync(250);
      if (settled) break;
    }
    await Promise.resolve();
    await Promise.resolve();

    // Real progress — watchdog stays alive, no false timeout.
    expect(settled).toBe(false);

    // Cleanup: close the bridge to settle the stream so the test ends cleanly.
    captured.closeCb?.(0);
    const result = await resultPromise;
    expect(result.stopReason).toBe("stop");
  });

  it("native streamSimple: execServerMessage progress pauses the idle watchdog (no false timeout during tool exec)", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {
      sessionId: "sess-exec-progress",
    });
    const resultPromise = stream.result();

    await waitForSilentBridgeReady(captured);

    // Build an execServerMessage{mcpArgs} frame — the only branch that fires onMcpExec
    // and therefore counts as forward progress per the predicate.
    const execFrame = frameConnectMessage(
      toBinary(
        AgentServerMessageSchema,
        create(AgentServerMessageSchema, {
          message: {
            case: "execServerMessage",
            value: {
              id: 1,
              execId: "exec-mcp-progress",
              message: {
                case: "mcpArgs",
                value: {
                  name: "shell",
                  args: {},
                  toolCallId: "tc_exec_progress",
                  providerIdentifier: "",
                  toolName: "shell",
                },
              },
            } as never,
          },
        }),
      ),
    );

    captured.dataCb?.(execFrame);
    // After exec progress, the watchdog is paused (proxy.ts:idleWatchdog.pause()) and the writer
    // closes with reason "toolUse". Advance well past the configured timeout to confirm no idle
    // timeout fires.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("toolUse");
    expect(result.errorMessage).toBeUndefined();
  });

  it("native streamSimple: answers Cursor WebFetch interaction queries instead of idling", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel("composer-2.5"), makeUserContext(), {
      sessionId: "sess-webfetch-interaction-query",
    });
    const resultPromise = stream.result();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await waitForSilentBridgeReady(captured);

    await vi.advanceTimersByTimeAsync(750);
    captured.dataCb?.(webFetchInteractionQueryFrame(7));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(settled).toBe(false);
    const response = decodeLastInteractionResponse(captured);
    expect(response.id).toBe(7);
    expect(response.$unknown).toEqual([
      { no: 9, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) },
    ]);

    captured.dataCb?.(webFetchInteractionQueryFrame(8));
    await Promise.resolve();
    const secondResponse = decodeLastInteractionResponse(captured);
    expect(secondResponse.id).toBe(8);

    captured.closeCb?.(0);
    const result = await resultPromise;
    expect(result.stopReason).toBe("stop");
  });

  it("native streamSimple: logs Cursor-side MCP tool errors without masking idle timeouts", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    process.env.PI_CURSOR_PROVIDER_DEBUG = "1";
    const debugFile = `/tmp/pi-cursor-provider-mcp-error-test-${process.pid}-${Date.now()}.log`;
    debugLogFileForCleanup = debugFile;
    process.env.PI_CURSOR_PROVIDER_DEBUG_FILE = debugFile;
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel("composer-2.5"), makeUserContext(), {
      sessionId: "sess-mcp-tool-error-progress",
    });
    const resultPromise = stream.result();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await waitForSilentBridgeReady(captured);

    for (let elapsed = 0; elapsed < 1500; elapsed += 250) {
      captured.dataCb?.(mcpToolCompletedErrorFrame(`tool_error_${elapsed}`));
      await vi.advanceTimersByTimeAsync(250);
      if (settled) break;
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
    const debugEvents = readDebugEvents(debugFile);
    expect(debugEvents).toContainEqual(
      expect.objectContaining({
        event: "native.stream.mcp_tool_error",
        callId: "tool_error_0",
        resultCase: "error",
        toolName: "mcp_pi_fh_web_fetch",
        mcpName: "mcp_pi_fh_web_fetch",
        providerIdentifier: "pi",
        error: "Tool execution error",
      }),
    );
    const result = await resultPromise;
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Cursor stream idle timeout after 1000ms without upstream data");
  });

  it("native streamSimple: kvServerMessage exchanges reset the idle watchdog (no false timeout during blob streaming)", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {
      sessionId: "sess-kv-progress",
    });
    const resultPromise = stream.result();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await waitForSilentBridgeReady(captured);

    // setBlobArgs frame — exercises the KV branch handled by handleKvMessage.
    const kvFrame = frameConnectMessage(
      toBinary(
        AgentServerMessageSchema,
        create(AgentServerMessageSchema, {
          message: {
            case: "kvServerMessage",
            value: {
              id: 1,
              message: {
                case: "setBlobArgs",
                value: { blobId: new Uint8Array([1, 2, 3, 4]), blobData: new Uint8Array([9, 9, 9]) },
              },
            } as never,
          },
        }),
      ),
    );

    for (let elapsed = 0; elapsed < 1500; elapsed += 250) {
      captured.dataCb?.(kvFrame);
      await vi.advanceTimersByTimeAsync(250);
      if (settled) break;
    }
    await Promise.resolve();
    await Promise.resolve();

    // Real progress — watchdog stays alive, no false timeout.
    expect(settled).toBe(false);

    // Cleanup: close the bridge to settle the stream so the test ends cleanly.
    captured.closeCb?.(0);
    const result = await resultPromise;
    expect(result.stopReason).toBe("stop");
  });

  it("native streamSimple: abort clears idle watchdog and heartbeat timers", async () => {
    vi.useFakeTimers();
    process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS = "1000";
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const captured = installSilentBridge();
    const streamSimple = createCursorNativeStream({ getAccessToken: async () => "test-token" });
    const controller = new AbortController();

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {
      sessionId: "sess-idle-abort",
      signal: controller.signal,
    });
    const resultPromise = stream.result();
    await waitForSilentBridgeReady(captured);

    controller.abort();
    const result = await resultPromise;

    expect(result.stopReason).toBe("aborted");
    expect(captured.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns 409 with hadStoredCheckpoint=true when checkpoint is fresh but pending tool-call ids do not match", async () => {
    const port = await startProxy(async () => "test-token");
    const sessionId = "sess-mismatch-1";
    const requestBody = {
      model: "gpt-5.4",
      pi_session_id: sessionId,
      messages: [
        { role: "user" as const, content: "hello" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            { id: "tc_unexpected", type: "function" as const, function: { name: "shell", arguments: "{}" } },
          ],
        },
        { role: "tool" as const, tool_call_id: "tc_unexpected", content: "ok" },
      ],
      stream: true,
    };
    const convKey = deriveConversationKey(requestBody.messages, sessionId);
    // Pre-seed a fresh checkpoint (matches completedTurns.length=0 since the request has no completed turns)
    // but with a different pending tool-call id.
    __testInternals.conversationStates.set(convKey, {
      conversationId: "synthetic-conv-id",
      checkpoint: new Uint8Array([9, 9]),
      checkpointTurnCount: 0,
      checkpointHistoryFingerprint: __testInternals.fingerprintCompletedTurns([]),
      midPausePendingToolCalls: [{ toolCallId: "tc_expected_other_id", toolName: "shell" }],
      sessionScoped: true,
      sessionId,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    });

    const result = await postChat(port, requestBody);
    expect(result.status).toBe(409);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body.error).toMatchObject({
      type: "invalid_state_error",
      code: "tool_continuation_lost",
      hadStoredCheckpoint: true,
    });
  });
});

describe("non-streaming handleNonStreamingResponse: server half-close ('end') completes the response", () => {
  afterEach(() => {
    vi.useRealTimers();
    __testInternals.setMetricEmitterForTests(noopMetricEmitter);
    stopProxy();
    setBridgeFactoryForTests();
    __testInternals.activeBridges.clear();
    __testInternals.conversationStates.clear();
  });

  function makeTextDeltaFrame(text: string): Buffer {
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text }),
          },
        }),
      },
    });
    return frameConnectMessage(toBinary(AgentServerMessageSchema, msg));
  }

  it("completes the HTTP response (200) when server half-closes cleanly via onResponseEnd", async () => {
    // P1 reproducer: before the fix, handleNonStreamingResponse never registers
    // bridge.onResponseEnd, so a clean server half-close ('end' → onResponseEnd)
    // is a no-op → onClose never fires → the Promise hangs forever.

    let dataCb: ((chunk: Buffer) => void) | undefined;
    let onResponseEndCb: (() => void) | undefined;
    let closeCb: ((code: number) => void) | undefined;

    // Use a deferred so the simulation fires only after the proxy has registered
    // its callbacks (avoiding a race with the synchronous bridge.write in
    // startBridge).
    let deferredCbsResolve!: () => void;
    const deferredCbs = new Promise<void>((r) => { deferredCbsResolve = r; });
    let ready = false;

    setBridgeFactoryForTests(() => {
      const handle: BridgeHandle = {
        proc: { kill: () => true },
        alive: true as unknown as boolean,
        write(_data: Uint8Array) {
          // startBridge fires bridge.write before handleNonStreamingResponse
          // registers its callbacks. Defer the simulation until the test has
          // waited for readiness.
          if (ready) return;
          ready = true;
          queueMicrotask(() => deferredCbsResolve());
        },
        end() {},
        onData(cb) {
          dataCb = cb;
        },
        onClose(cb) {
          closeCb = cb;
        },
        onResponseEnd(cb) {
          onResponseEndCb = cb;
        },
      };
      return handle;
    });

    const port = await startProxy(async () => "test-token");

    // Use AbortController to bound the test; if the response never completes
    // (the hang), we get a clear failure instead of waiting forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const resultP = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user" as const, content: "hi" }],
        stream: false,
      }),
      signal: controller.signal,
    }).then(async (res) => ({ status: res.status, json: await res.json() as Record<string, unknown> }));

    // Wait for the bridge to be created and callbacks registered.
    await deferredCbs;
    expect(dataCb).toBeDefined();
    expect(closeCb).toBeDefined();

    // Before the fix: onResponseEndCb is undefined — the proxy never registered
    // a handler. This means server half-close is a no-op and the Promise hangs.
    // After the fix: onResponseEndCb is defined and fires completeResponse.
    expect(onResponseEndCb).toBeDefined();

    // Simulate: server sends a text response, then half-closes (END_STREAM).
    dataCb!(makeTextDeltaFrame("Hello world"));

    // Server half-close → bridge.onResponseEnd. On pre-fix code this is a no-op
    // (no handler registered) so onClose never fires and the response hangs.
    onResponseEndCb!();

    // The fix calls bridge.end() inside onResponseEnd, which triggers the
    // deferred onClose(0) as a no-op via the cleanCompletionHandled guard.
    closeCb!(0);

    const result = await resultP;
    clearTimeout(timeout);
    expect(result.status).toBe(200);
    const body = result.json as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    expect(body.choices?.[0]?.message?.content).toBe("Hello world");
    expect(body.choices?.[0]?.finish_reason).toBe("stop");
  }, 10_000);
});
