/**
 * End-to-end integration test for the in-process Connect transport.
 *
 * This test exists specifically to close the isolation gap that hid the P0/P1
 * double-framing bug: `connect-transport.test.ts` exercised the transport in
 * isolation (asserting it delivered DE-FRAMED payloads), while `proxy.ts` was
 * exercised against mocked bridges that delivered PRE-DE-FRAMED bytes. The two
 * halves agreed on a DIFFERENT framing contract, so no test ever wired the
 * transport's real framing THROUGH `proxy.ts`.
 *
 * Here we drive the REAL in-process transport (`createConnectBridgeHandle`) —
 * injected as the bridge factory — with a fake `node:http2` session that emits
 * genuine 5-byte-framed Connect `AgentServerMessage` bytes, and assert on the
 * events that reach `writeNativeStream` via the public `createCursorNativeStream`
 * entry. The four scenarios below are the acceptance gate for the audit fixes.
 */
import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import {
  CONNECT_END_STREAM_FLAG,
  frameConnectMessage,
} from "../src/bridge";
import { createConnectBridgeHandle } from "../src/connect-transport";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
} from "../src/proto/agent_pb";
import {
  __testInternals,
  createCursorNativeStream,
  setBridgeFactoryForTests,
  stopProxy,
} from "../src/proxy";

const noopMetricEmitter = (): void => undefined;
__testInternals.setMetricEmitterForTests(noopMetricEmitter);

// ── Fixtures / helpers ──

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
  return { messages: [{ role: "user", content: text, timestamp: Date.now() }] };
}

/** Build a genuine 5-byte-framed Connect `AgentServerMessage` carrying text. */
function makeTextFrame(text: string): Buffer {
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

/** Build a genuine 5-byte-framed Connect end-stream error frame (flags 0b10). */
function makeEndStreamErrorFrame(code: string, message: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }));
  return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

/**
 * Build a genuine 5-byte-framed Connect `AgentServerMessage` carrying an MCP
 * tool exec (`execServerMessage{mcpArgs}`). This is the only server-message
 * branch that fires `onMcpExec`, which registers the bridge via
 * `setActiveBridge` (the mid-tool-call pause) and closes the writer with
 * `toolUse`.
 */
function makeExecFrame(toolCallId = "tc_abort_pause"): Buffer {
  const msg = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: {
        id: 1,
        execId: "exec-abort-pause",
        message: {
          case: "mcpArgs",
          value: {
            name: "shell",
            args: {},
            toolCallId,
            providerIdentifier: "",
            toolName: "shell",
          },
        },
      } as never,
    },
  });
  return frameConnectMessage(toBinary(AgentServerMessageSchema, msg));
}

interface FakeH2Stream extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  closed: boolean;
  destroyed: boolean;
}

function createFakeH2Stream(): FakeH2Stream {
  const stream = new EventEmitter() as FakeH2Stream;
  stream.write = vi.fn(() => true);
  stream.end = vi.fn();
  stream.destroy = vi.fn(() => {
    stream.destroyed = true;
    return stream;
  });
  stream.closed = false;
  stream.destroyed = false;
  return stream;
}

interface FakeH2Client extends EventEmitter {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  closed: boolean;
  destroyed: boolean;
}

function createFakeH2Client(stream: FakeH2Stream): FakeH2Client {
  const client = new EventEmitter() as FakeH2Client;
  client.request = vi.fn(() => stream);
  client.close = vi.fn(() => {
    client.closed = true;
    return client;
  });
  client.destroy = vi.fn(() => {
    client.destroyed = true;
    return client;
  });
  client.ping = vi.fn();
  client.closed = false;
  client.destroyed = false;
  return client;
}

/** Use the REAL in-process transport as the bridge factory. */
function useRealTransport(): void {
  setBridgeFactoryForTests((opts) => createConnectBridgeHandle(opts));
}

function collectEvents(
  eventStream: ReturnType<ReturnType<typeof createCursorNativeStream>>,
  into: AssistantMessageEvent[],
): Promise<void> {
  return (async () => {
    for await (const ev of eventStream) into.push(ev);
  })();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __testInternals.setMetricEmitterForTests(noopMetricEmitter);
  __testInternals.activeBridges.clear();
  __testInternals.conversationStates.clear();
  setBridgeFactoryForTests();
  stopProxy();
});

describe("in-process transport ↔ proxy.ts integration (Connect framing)", () => {
  it("streaming: framed AgentServerMessage text reaches the writer", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {});
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    // Wait for the async provider entry to create the bridge (startBridge).
    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    stream.emit("data", makeTextFrame("Hello, "));
    stream.emit("data", makeTextFrame("world!"));
    stream.emit("close");

    await done;
    connectSpy.mockRestore();

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    // The double-framing bug would swallow ALL text (the de-framed payload is
    // re-fed to proxy.ts's parser, which reads protobuf tag bytes as a header).
    expect(text).toBe("Hello, world!");
    // And the stream completes cleanly (a `done`, not an `error`).
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("end-stream error surfaces Cursor's specific message (not 'Bridge connection lost')", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {});
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    stream.emit("data", makeTextFrame("partial answer"));
    // A genuine Connect end-stream error frame over HTTP 200.
    stream.emit("data", makeEndStreamErrorFrame("resource_exhausted", "rate limited"));
    stream.emit("close");

    await done;
    connectSpy.mockRestore();

    const errEvent = events.find((e) => e.type === "error") as
      | Extract<AssistantMessageEvent, { type: "error" }>
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.reason).toBe("error");
    // Cursor's specific end-stream error must surface — not the generic fallback.
    expect(errEvent!.error.errorMessage).toContain("rate limited");
    expect(errEvent!.error.errorMessage).not.toBe("Bridge connection lost");
  });

  it("401 (no upstream data) triggers exactly one refreshAccessToken + restart, then 200 succeeds", async () => {
    const stream1 = createFakeH2Stream();
    const stream2 = createFakeH2Stream();
    let requestCall = 0;
    const client = createFakeH2Client(stream1);
    // First request → stream1 (401), subsequent → stream2 (200).
    client.request = vi.fn(() => (requestCall++ === 0 ? stream1 : stream2));
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    let refreshCalls = 0;
    const streamFn = createCursorNativeStream({
      getAccessToken: async () => "initial-token",
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return "refreshed-token";
      },
    });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {});
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
    // First bridge: HTTP 401, NO upstream data.
    stream1.emit("response", { ":status": 401 });
    stream1.emit("close");

    // Wait for the single auth-refresh retry to spin up bridge 2.
    await vi.waitFor(() => expect(requestCall).toBe(2));
    // Second bridge: HTTP 200 success.
    stream2.emit("response", { ":status": 200 });
    stream2.emit("data", makeTextFrame("recovered"));
    stream2.emit("close");

    await done;
    connectSpy.mockRestore();

    expect(refreshCalls).toBe(1);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("recovered");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("user abort mid-stream yields an 'aborted' outcome, not 'error'", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const controller = new AbortController();
    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {
      signal: controller.signal,
    });
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    stream.emit("data", makeTextFrame("partial"));
    // User cancels mid-stream.
    controller.abort();

    await done;
    connectSpy.mockRestore();

    const errEvent = events.find((e) => e.type === "error") as
      | Extract<AssistantMessageEvent, { type: "error" }>
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.reason).toBe("aborted");
    // Must NOT surface as a generic connection-lost error.
    expect(errEvent!.error.errorMessage).not.toBe("Bridge connection lost");
  });

  it("user abort mid-tool-call removes the registered active bridge (no leak)", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const controller = new AbortController();
    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {
      signal: controller.signal,
    });
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    // Deliver a tool-call exec so the bridge is registered via setActiveBridge
    // (mid-pause) and the writer closes with "toolUse". The bridge stays alive
    // and resident in activeBridges while waiting for the tool-result resume.
    stream.emit("data", makeExecFrame());
    await done;

    // Sanity: the bridge really was registered before we abort. Without this,
    // the leak assertion below would pass vacuously.
    expect(__testInternals.activeBridges.size).toBe(1);

    // User aborts mid-tool-call. The in-process transport registers its own
    // abort listener at bridge-creation time (before the proxy's `abort`
    // listener), so on cancel the transport's onAbort -> fireClose(1) reaches
    // bridge.onClose while the proxy's abort listener (which would otherwise
    // call cleanupBridge) has already been removed by onClose. The onClose
    // abort branch must therefore clean up activeBridges itself.
    controller.abort();
    // onClose runs synchronously inside abort(); flush microtasks for safety.
    await new Promise((r) => setTimeout(r, 0));

    expect(__testInternals.activeBridges.size).toBe(0);

    connectSpy.mockRestore();
  });

  it("turn completes on server half-close ('end') without waiting for 'close'", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {});
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    stream.emit("data", makeTextFrame("answer"));
    stream.emit("end");

    await done;
    connectSpy.mockRestore();

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("answer");
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("end-stream error still surfaces when the turn ends via half-close ('end')", async () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    useRealTransport();

    const streamFn = createCursorNativeStream({ getAccessToken: async () => "tok" });
    const eventStream = streamFn(makeCursorModel(), makeUserContext("hi"), {});
    const events: AssistantMessageEvent[] = [];
    const done = collectEvents(eventStream, events);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalled());

    stream.emit("response", { ":status": 200 });
    stream.emit("data", makeTextFrame("partial"));
    stream.emit("data", makeEndStreamErrorFrame("resource_exhausted", "rate limited"));
    stream.emit("end");

    await done;
    connectSpy.mockRestore();

    const errEvent = events.find((e) => e.type === "error") as
      | Extract<AssistantMessageEvent, { type: "error" }>
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.error.errorMessage).toContain("rate limited");
    expect(errEvent!.error.errorMessage).not.toBe("Bridge connection lost");
  });
});
