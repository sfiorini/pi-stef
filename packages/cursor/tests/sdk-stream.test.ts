process.env.PI_CURSOR_AUTH_JSON_PATH ??= "/tmp/pi-stef-cursor-test-noauth.json";
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

  // Captured customTools from agent.send (for tests that need to execute them)
  let capturedCustomTools: Record<string, { execute: Function }> | undefined;

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
        // Capture customTools so tests can execute them directly
        if (opts?.local?.customTools) {
          capturedCustomTools = opts.local.customTools as Record<string, { execute: Function }>;
        }
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
    getCustomTools: () => capturedCustomTools,
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

    // P1-a: after RESUME, lastSentMessageIndex should be updated
    expect(fakeSession.lastSentMessageIndex).toBe(contextMessages.length);
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

  // Case 4b: P2-a — abort + run resolves cancelled → error{reason:'aborted'} (not done)
  it("case 4b: P2-a — abort + run resolves cancelled → error", async () => {
    const { deps } = await createFakeDeps();
    const controller = new AbortController();

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      { signal: controller.signal } as unknown as Parameters<typeof streamCursor>[2],
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for send to be called
    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    // Abort — sets the aborted flag
    controller.abort();

    // Now the run.wait() resolves with cancelled status
    // (The cancel() call from onAbort rejects the deferred in the fake, but
    //  in the real SDK, wait() can resolve with {status:'cancelled'})
    // The deferred was already rejected by cancel(), so the catch block runs.
    // But the test verifies that the error reason is 'aborted'.

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");

    const errorEvent = events.find((e) => e.type === "error") as Extract<
      AssistantMessageEvent,
      { type: "error" }
    >;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.reason).toBe("aborted");
  });

  // Case 4c: P2-a targeted — abort, then run.wait() resolves cancelled → error
  it("case 4c: P2-a — run.wait() resolves cancelled after abort → error", async () => {
    const { deps } = await createFakeDeps();
    const controller = new AbortController();

    // Create a run where cancel does NOT reject the deferred,
    // and we manually resolve with cancelled after abort.
    const manualRunDeferred = deferred<{ status: string; usage?: Record<string, number> }>();
    const manualFakeRun = {
      wait: () => manualRunDeferred.promise,
      cancel: vi.fn(async () => { /* no-op — doesn't reject */ }),
    };
    // Replace agent.send to return our manual run
    deps.acquireSessionAgent.mockImplementation(async () => {
      const bridgeModule = await import("../src/tool-result-bridge");
      const coordModule = await import("../src/turn-coordinator");
      const initialPartial = {
        role: "assistant" as const,
        content: [],
        api: "cursor-sdk",
        provider: "cursor",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: undefined as unknown as "stop",
        timestamp: Date.now(),
      };
      let sessionRef!: SessionAgent;
      const coordinator = new coordModule.CursorSdkTurnCoordinator(
        initialPartial,
        (e: AssistantMessageEvent) => { sessionRef?.targetStream?.push?.(e); },
      );
      const session: SessionAgent = {
        agent: {
          send: vi.fn(async () => manualFakeRun),
          close: vi.fn(async () => {}),
        } as unknown as SessionAgent["agent"],
        currentRun: undefined,
        coordinator,
        partial: initialPartial,
        bridge: bridgeModule.createToolResultBridge(),
        lastSentMessageIndex: 0,
        firstTurn: true,
        targetStream: undefined,
        modelSelection: { id: "test-model" },
        apiKey: "crsr_test_key_12345",
      };
      sessionRef = session;
      return { session, release: vi.fn() };
    });

    const stream = streamCursor(
      fakeModel(),
      { messages: [] } as unknown as Context,
      { signal: controller.signal } as unknown as Parameters<typeof streamCursor>[2],
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // Wait for send to be called
    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    // Abort first
    controller.abort();

    // Then run resolves with cancelled (real SDK behavior)
    manualRunDeferred.resolve({ status: "cancelled" });

    const result = await stream.result();
    // MUST be aborted, NOT stop
    expect(result.stopReason).toBe("aborted");

    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("done"); // done event must NOT be emitted
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

  // Case 8: P2-c — bridge emitter makes custom tools visible WITHOUT SDK tool-call-started
  it("case 8: P2-c — bridge execute without SDK started → exactly one toolcall_start + done('toolUse')", async () => {
    // Use a custom acquireSessionAgent that wires execute() into the send mock
    // so the SDK's send() triggers the custom tool call AFTER runPhase sets up
    // the Promise.race with bridge.whenPending().
    const bridgeModule = await import("../src/tool-result-bridge");
    const coordModule = await import("../src/turn-coordinator");

    const runDeferred = deferred<{ status: string; usage?: Record<string, number> }>();
    const fakeRun = {
      wait: () => runDeferred.promise,
      cancel: vi.fn(async () => { runDeferred.reject(new Error("aborted")); }),
    };

    let capturedCustomTools: Record<string, { execute: Function }> | undefined;

    const initialPartial: AssistantMessage = {
      role: "assistant", content: [], api: "cursor-sdk", provider: "cursor",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: undefined as unknown as "stop",
      timestamp: Date.now(),
    };
    const bridge = bridgeModule.createToolResultBridge();
    let sessionRef!: SessionAgent;
    const coordinator = new coordModule.CursorSdkTurnCoordinator(
      initialPartial,
      (e: AssistantMessageEvent) => { sessionRef?.targetStream?.push?.(e); },
    );
    const fakeSession: SessionAgent = {
      agent: undefined as unknown as SessionAgent["agent"],
      currentRun: undefined,
      coordinator,
      partial: initialPartial,
      bridge,
      lastSentMessageIndex: 0,
      firstTurn: true,
      targetStream: undefined,
      modelSelection: { id: "test-model" },
      apiKey: "crsr_test_key_12345",
    } as SessionAgent;
    sessionRef = fakeSession;

    // send() captures customTools, then uses setTimeout to fire execute() after
    // runPhase has set up the Promise.race with bridge.whenPending().
    const fakeAgent = {
      send: vi.fn(async (
        _msg: unknown,
        opts?: { onDelta?: (a: { update: Record<string, unknown> }) => void; onStep?: (a: { step: Record<string, unknown> }) => void; local?: Record<string, unknown> },
      ) => {
        if (opts?.local?.customTools) {
          capturedCustomTools = opts.local.customTools as Record<string, { execute: Function }>;
          // Fire execute AFTER runPhase sets up the race (macrotask ensures race is ready)
          setTimeout(() => {
            capturedCustomTools!["pi__read_file"]?.execute(
              { path: "/tmp/x" },
              { toolCallId: "tc_bridge" },
            );
          }, 5);
        }
        return fakeRun;
      }),
      close: vi.fn(async () => {}),
    };
    Object.assign(fakeSession, { agent: fakeAgent });

    const deps = {
      loadSdk: vi.fn(async () => ({} as CursorSdkModule)),
      applyHttp1Config: vi.fn(async () => {}),
      resolveApiKey: vi.fn(async () => "crsr_test_key_12345"),
      acquireSessionAgent: vi.fn(async () => ({ session: fakeSession, release: vi.fn() })),
      classifyCursorError: vi.fn(async (err: unknown) => ({
        reason: err instanceof Error && /abort/i.test(err.message) ? "aborted" : "error",
        message: err instanceof Error ? err.message : String(err),
      })),
      // No buildCustomTools override — real one is used
    };

    const contextTools = [
      { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ];

    const stream = streamCursor(
      fakeModel(),
      { messages: [], tools: contextTools } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    // The send mock will fire execute() via setTimeout after5ms.
    // By then, runPhase has set up the race and bridge.whenPending() is armed.
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");

    // Exactly ONE toolcall_start for this callId
    const allToolcallStarts = events.filter((e) => e.type === "toolcall_start");
    expect(allToolcallStarts.length).toBe(1);
    // contentIndex must be valid (0), not -1
    expect((allToolcallStarts[0] as AssistantMessageEvent & { contentIndex: number }).contentIndex).toBe(0);
    // Name must be stripped of pi__ prefix
    const toolBlock = (allToolcallStarts[0] as AssistantMessageEvent & { partial?: AssistantMessage }).partial?.content[0] as { type: string; name: string };
    expect(toolBlock).toMatchObject({ type: "toolCall", name: "read_file" });

    // At least one toolcall_delta
    const deltas = events.filter((e) => e.type === "toolcall_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });

  // Case 8b: P2-c dedup — bridge execute + SDK tool-call-started for SAME callId
  it("case 8b: P2-c — bridge execute + SDK tool-call-started same callId → still one toolcall_start", async () => {
    const { fakeSession, deps, fireDelta, getCustomTools } = await createFakeDeps();
    // Use real buildCustomTools
    delete (deps as Record<string, unknown>).buildCustomTools;

    // Use pi-ai Context.tools format
    const contextTools = [
      { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ];

    const stream = streamCursor(
      fakeModel(),
      { messages: [], tools: contextTools } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events = collectStreamEvents(stream);

    await vi.waitFor(() => {
      expect(getCustomTools()).toBeDefined();
    });
    // Extra tick for runPhase to reach the race point
    await new Promise((r) => setTimeout(r, 20));

    const customTools = getCustomTools()!;
    const readTool = customTools["pi__read_file"];

    // 1) Execute tool WITHOUT SDK started → bridgeToolStart creates block + emits start
    const execPromise = readTool.execute({ path: "/tmp/x" }, { toolCallId: "tc_dedup" }).catch(() => {});

    // 2) SDK ALSO fires tool-call-started for the SAME callId
    fireDelta({
      type: "tool-call-started",
      callId: "tc_dedup",
      toolCall: { type: "pi__read_file", args: { path: "/tmp/x" } },
    });

    // Still exactly one toolcall_start
    const allToolcallStarts = events.filter((e) => e.type === "toolcall_start");
    expect(allToolcallStarts.length).toBe(1);

    // Complete the call
    fireDelta({
      type: "tool-call-completed",
      callId: "tc_dedup",
      toolCall: { type: "pi__read_file", args: { path: "/tmp/x" } },
    });

    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");

    // Final check: still one toolcall_start, one toolcall_end
    expect(events.filter((e) => e.type === "toolcall_start").length).toBe(1);
    expect(events.filter((e) => e.type === "toolcall_end").length).toBe(1);

    // Resolve the bridge pending so execPromise settles
    fakeSession.bridge.resolveFromToolResults([{ toolCallId: "tc_dedup", text: "done" }]);
    await execPromise;
  });

  // Case 7: P0 regression — multi-turn: second turn content is NOT empty
  it("case 7: P0 — second turn content is NOT empty (coordinator partial stays valid)", async () => {
    const { fakeSession, deps, fireDelta, runDeferred } = await createFakeDeps();

    // ─── TURN 1: firstTurn:true → text deltas → done("stop") with content "hi" ───
    const stream1 = streamCursor(
      fakeModel(),
      { messages: [{ role: "user", content: "hello" }] } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events1 = collectStreamEvents(stream1);

    await vi.waitFor(() => {
      expect(deps.loadSdk).toHaveBeenCalled();
    });

    fireDelta({ type: "text-delta", text: "hi" });
    fireDelta({
      type: "turn-ended",
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    runDeferred.resolve({ status: "finished" });

    const result1 = await stream1.result();
    expect(result1.stopReason).toBe("stop");
    // Verify turn 1 content
    const textContent1 = result1.content.find((c) => c.type === "text") as { type: string; text: string };
    expect(textContent1?.text).toBe("hi");

    // ─── TURN 2: firstTurn:false → new text deltas → content should contain "second" ───
    // Reset fake run for turn 2
    const runDeferred2 = deferred<{ status: string; usage?: Record<string, number> }>();
    const fakeRun2 = {
      wait: () => runDeferred2.promise,
      cancel: vi.fn(async () => {}),
    };
    fakeSession.currentRun = undefined; // run was cleared by finalize
    // Re-wire fakeAgent.send to return new run
    fakeSession.agent.send = vi.fn(async () => fakeRun2) as typeof fakeSession.agent.send;

    // Turn 2 onDelta/onStep will be captured fresh
    let capturedOnDelta2: ((a: { update: Record<string, unknown> }) => void) | undefined;
    (fakeSession.agent.send as ReturnType<typeof vi.fn>).mockImplementation(
      async (_msg: unknown, opts?: { onDelta?: (a: { update: Record<string, unknown> }) => void }) => {
        capturedOnDelta2 = opts?.onDelta;
        return fakeRun2;
      },
    );

    const stream2 = streamCursor(
      fakeModel(),
      { messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: "second" },
      ] } as unknown as Context,
      undefined,
      deps as unknown as Parameters<typeof streamCursor>[3],
    );
    const events2 = collectStreamEvents(stream2);

    await vi.waitFor(() => {
      expect(fakeSession.agent.send).toHaveBeenCalled();
    });

    // Fire text deltas for turn 2
    capturedOnDelta2?.({ update: { type: "text-delta", text: "second" } });
    capturedOnDelta2?.({
      update: {
        type: "turn-ended",
        usage: { inputTokens: 60, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    runDeferred2.resolve({ status: "finished" });

    const result2 = await stream2.result();
    expect(result2.stopReason).toBe("stop");

    // THE KEY ASSERTION: content must contain "second", NOT be empty
    const textContent2 = result2.content.find((c) => c.type === "text") as { type: string; text: string };
    expect(textContent2).toBeDefined();
    expect(textContent2.text).toBe("second");

    // Coordinator's partial should be the SAME object as session.partial
    expect(fakeSession.coordinator.partial).toBe(fakeSession.partial);

    // Verify turn 1 events (P0 regression: text_start + text_delta + done)
    const turn1Types = events1.map((e) => e.type);
    expect(turn1Types).toContain("start");
    expect(turn1Types).toContain("text_start");
    expect(turn1Types).toContain("text_delta");
    expect(turn1Types).toContain("done");

    // Verify turn 2 events (same pattern, content is NOT empty)
    const turn2Types = events2.map((e) => e.type);
    expect(turn2Types).toContain("start");
    expect(turn2Types).toContain("text_start");
    expect(turn2Types).toContain("text_delta");
    expect(turn2Types).toContain("done");
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
