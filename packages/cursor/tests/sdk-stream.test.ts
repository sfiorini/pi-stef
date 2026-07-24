import { describe, expect, it, vi } from "vitest";
import { streamCursor, streamCursorLazy } from "../src/sdk-stream";
import type {
  AssistantMessageEvent,
  AssistantMessage,
  Context,
  Model,
  Api,
} from "@earendil-works/pi-ai";
import type { CursorSdkModule } from "../src/sdk-runtime";
import type { SessionAgent } from "../src/session-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a deferred promise that can be resolved/rejected externally. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "cursor",
    api: "cursor-sdk" as unknown as Api,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

/**
 * Set up all the fakes needed for testing streamCursor.
 *
 * The fake session uses the REAL coordinator and bridge so that:
 * - Coordinator events flow through session.targetStream → stream.push
 * - Bridge.pending() properly arms whenPending()
 *
 * Events are captured by overriding stream.push on the returned stream.
 */
async function createFakeDeps() {
  const bridgeModule = await import("../src/tool-result-bridge");
  const coordModule = await import("../src/turn-coordinator");

  let capturedOnDelta:
    | ((a: { update: Record<string, unknown> }) => void)
    | undefined;
  let capturedOnStep:
    | ((a: { step: Record<string, unknown> }) => void)
    | undefined;

  // Default runDeferred — resolved by individual tests
  const runDeferred = deferred<{
    status: string;
    usage?: Record<string, number>;
  }>();
  const fakeRun = {
    wait: () => runDeferred.promise,
    cancel: vi.fn(async () => {
      // When cancel is called (e.g. from abort), reject the deferred
      runDeferred.reject(new Error("aborted"));
    }),
    status: "running" as string,
  };

  const fakeAgent = {
    send: vi.fn(
      async (
        _msg: unknown,
        opts?: {
          onDelta?: (a: { update: Record<string, unknown> }) => void;
          onStep?: (a: { step: Record<string, unknown> }) => void;
          local?: Record<string, unknown>;
        },
      ) => {
        capturedOnDelta = opts?.onDelta;
        capturedOnStep = opts?.onStep;
        return fakeRun;
      },
    ),
    close: vi.fn(async () => {}),
    reload: vi.fn(),
  };

  const initialPartial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "cursor-sdk",
    provider: "cursor",
    model: "test-model",
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

  const bridge = bridgeModule.createToolResultBridge();

  // Real coordinator — its push callback targets session.targetStream
  let sessionRef!: SessionAgent;
  const coordinator = new coordModule.CursorSdkTurnCoordinator(
    initialPartial,
    (e: AssistantMessageEvent) => {
      sessionRef?.targetStream?.push?.(e);
    },
  );

  const fakeSession: SessionAgent = {
    agent: fakeAgent as unknown as SessionAgent["agent"],
    currentRun: undefined,
    coordinator,
    partial: initialPartial,
    bridge,
    lastSentMessageIndex: 0,
    firstTurn: true,
    targetStream: undefined,
    modelSelection: { id: "test-model" },
    apiKey: "crsr_test_key_12345",
  };
  sessionRef = fakeSession;

  const deps = {
    loadSdk: vi.fn(async () => ({} as CursorSdkModule)),
    applyHttp1Config: vi.fn(async () => {}),
    resolveApiKey: vi.fn<() => Promise<string | undefined>>(async () => "crsr_test_key_12345"),
    acquireSessionAgent: vi.fn(async () => ({
      session: fakeSession,
      release: vi.fn(),
    })),
    classifyCursorError: vi.fn(async (err: unknown) => ({
      reason: err instanceof Error && /abort/i.test(err.message)
        ? "aborted"
        : "error",
      message: err instanceof Error ? err.message : String(err),
    })),
    buildCustomTools: vi.fn(() => ({})),
  };

  return {
    fakeAgent,
    fakeSession,
    fakeRun,
    runDeferred,
    deps,
    fireDelta: (update: Record<string, unknown>) => capturedOnDelta?.({ update }),
    fireStep: (step: Record<string, unknown>) => capturedOnStep?.({ step }),
  };
}

/**
 * Intercept a stream's push() method to capture all events.
 * Returns the events array.
 *
 * This must be called BEFORE the microtask in streamCursor fires,
 * which is fine since streamCursor returns synchronously.
 */
function collectStreamEvents(
  stream: ReturnType<typeof streamCursor>,
): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  const origPush = stream.push.bind(stream);
  stream.push = ((e: AssistantMessageEvent) => {
    events.push(e);
    return origPush(e);
  }) as typeof stream.push;
  return events;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("streamCursor (S-62 two-phase)", () => {
  it("streamCursorLazy is re-exported", () => {
    expect(streamCursorLazy).toBe(streamCursor);
  });

  // Case 1: NEW turn — text deltas → done("stop")
  it("case 1: new turn with text deltas → done('stop') with usage", async () => {
    const { deps, fireDelta, runDeferred } = await createFakeDeps();

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for the fake send to be called (runPhase microtask)
    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    // Simulate SDK sending text deltas via the captured onDelta callback
    fireDelta({ type: "text-delta", text: "Hello" });

    // Simulate turn-ended with usage
    fireDelta({
      type: "turn-ended",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    // Resolve the run (status: "finished")
    runDeferred.resolve({ status: "finished" });

    // Wait for the stream to complete
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");

    // Verify event sequence includes all expected events
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");

    const doneEvent = events.find((e) => e.type === "done") as Extract<
      AssistantMessageEvent,
      { type: "done" }
    >;
    expect(doneEvent.reason).toBe("stop");

    // Usage from turn-ended should be on the partial
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(20);
  });

  // Case 2: NEW turn — tool call → done("toolUse"), currentRun kept, bridge.hasPending()
  it("case 2: new turn with tool call → done('toolUse')", async () => {
    const { fakeSession, deps, fireDelta } = await createFakeDeps();

    const contextTools = [
      {
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ];

    const stream = streamCursor(
      fakeModel(),
      { messages: [], tools: contextTools } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for runPhase to call send
    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    // Simulate SDK firing tool-call events through onDelta
    fireDelta({
      type: "tool-call-started",
      callId: "tc1",
      toolCall: { type: "read_file", args: { path: "/tmp/hello.txt" } },
    });
    fireDelta({
      type: "tool-call-delta",
      callId: "tc1",
      modelCallId: "tc1",
      taskUpdate: {
        type: "tool-call-started",
        text: '{"path":"/tmp/hello.txt"}',
      },
    });
    fireDelta({
      type: "tool-call-completed",
      callId: "tc1",
      toolCall: {
        type: "read_file",
        args: { path: "/tmp/hello.txt" },
      },
    });

    // Arm the bridge — simulates the customTool.execute() calling bridge.pending()
    fakeSession.bridge.pending(
      "tc1",
      "read_file",
      '{"path":"/tmp/hello.txt"}',
    );

    // Wait for the stream to complete with done("toolUse")
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");

    // Verify event sequence
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("toolcall_end");
    expect(types).toContain("done");

    const doneEvent = events.find((e) => e.type === "done") as Extract<
      AssistantMessageEvent,
      { type: "done" }
    >;
    expect(doneEvent.reason).toBe("toolUse");

    // The tool call should be on the partial
    const toolCall = result.content.find((c) => c.type === "toolCall") as {
      type: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolCall).toBeDefined();
    expect(toolCall.name).toBe("read_file");

    // currentRun is preserved (streamCursor doesn't clear it on pause)
    expect(fakeSession.currentRun).toBeDefined();
    expect(fakeSession.bridge.hasPending()).toBe(true);
  });

  // Case 3: RESUME turn — resolveFromToolResults → resumed deltas → done("stop")
  it("case 3: resume turn → done('stop')", async () => {
    const { fakeSession, deps } = await createFakeDeps();

    // Pre-arm the bridge with a pending tool call (simulating a paused turn)
    fakeSession.bridge.pending(
      "tc1",
      "read_file",
      '{"path":"/tmp/hello.txt"}',
    );

    // The session has an active currentRun with its own deferred
    const resumeDeferred = deferred<{
      status: string;
      usage?: Record<string, number>;
    }>();
    const resumeRun = {
      wait: () => resumeDeferred.promise,
      cancel: vi.fn(async () => {}),
    };
    fakeSession.currentRun = resumeRun;
    fakeSession.firstTurn = false;

    // extractToolResults will return matching results
    deps.buildCustomTools.mockReturnValue({});

    // Provide tool-result messages in context
    const contextMessages = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read_file",
        content: [{ type: "text", text: "file contents here" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const stream = streamCursor(
      fakeModel(),
      { messages: contextMessages } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for runPhase to set session.targetStream
    await vi.waitFor(() => {
      expect(fakeSession.targetStream).toBeDefined();
    });

    // Simulate the resumed run producing deltas through the coordinator
    // (in the real SDK, the original onDelta callback fires from the resumed run;
    //  here we drive the coordinator directly since send() is not called on resume)
    fakeSession.coordinator.handleDelta({
      update: { type: "text-delta", text: "I read the file" },
    } as unknown as Parameters<typeof fakeSession.coordinator.handleDelta>[0]);
    fakeSession.coordinator.handleDelta({
      update: {
        type: "turn-ended",
        usage: {
          inputTokens: 150,
          outputTokens: 30,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    } as unknown as Parameters<typeof fakeSession.coordinator.handleDelta>[0]);

    // Resolve the resumed run
    resumeDeferred.resolve({ status: "finished" });

    const result = await stream.result();
    expect(result.stopReason).toBe("stop");

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");

    const doneEvent = events.find((e) => e.type === "done") as Extract<
      AssistantMessageEvent,
      { type: "done" }
    >;
    expect(doneEvent.reason).toBe("stop");

    // Usage from turn-ended
    expect(result.usage.input).toBe(150);
    expect(result.usage.output).toBe(30);

    // Bridge should be resolved (no more pending)
    expect(fakeSession.bridge.hasPending()).toBe(false);
  });

  // Case 4: Abort → run.cancel() + error{reason:"aborted"}
  it("case 4: abort → error{reason:'aborted'}", async () => {
    const { fakeRun, deps } = await createFakeDeps();
    const controller = new AbortController();

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      { signal: controller.signal } as unknown as Parameters<
        typeof streamCursor
      >[2],
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for runPhase to call send (ensures onAbort is wired)
    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    // Abort — this triggers onAbort → cancel() → deferred rejects
    controller.abort();

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toContain("aborted");

    // run.cancel should have been called
    expect(fakeRun.cancel).toHaveBeenCalled();

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("error");

    const errorEvent = events.find((e) => e.type === "error") as Extract<
      AssistantMessageEvent,
      { type: "error" }
    >;
    expect(errorEvent.reason).toBe("aborted");
  });

  // Case 5: No key → error mentions /cursor-login
  it("case 5: no key → error mentions /cursor-login", async () => {
    const { deps } = await createFakeDeps();
    deps.resolveApiKey.mockReturnValue(Promise.resolve(undefined));

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("/cursor-login");

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("error");
  });

  // Case 6: default resolver (no resolveApiKey dep) → error (no key in test env)
  it("case 6: default resolver uses resolveCursorRuntimeApiKey", async () => {
    const { deps } = await createFakeDeps();
    // Remove the resolveApiKey override — test the default wiring
    delete (deps as Record<string, unknown>).resolveApiKey;

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    const result = await stream.result();
    // In test env: no CURSOR_API_KEY env var and no stored credential
    // → resolveCursorRuntimeApiKey returns undefined
    // → streamCursor emits an error mentioning /cursor-login
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("/cursor-login");

    const types = events.map((e) => e.type);
    expect(types).toContain("error");
  });
});
