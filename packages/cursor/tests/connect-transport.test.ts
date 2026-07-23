import http2 from "node:http2";
import https from "node:https";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../src/bridge";
import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
  resolveCursorRequestHeaders,
} from "../src/cursor-request-headers";
import { type BridgeHandle, frameConnectMessage, CONNECT_END_STREAM_FLAG } from "../src/bridge";
import { createConnectBridgeHandle, resolveTransportMode } from "../src/connect-transport";
import { resolveBridgeFactory } from "../src/proxy";

const baseOptions = {
  accessToken: "tok_abc",
  rpcPath: "/agent.v1.AgentService/Run",
};

describe("resolveCursorRequestHeaders", () => {
  afterEach(() => {
    delete process.env.PI_CURSOR_CLIENT_VERSION;
  });

  it("sets Connect streaming content-type and bearer auth", () => {
    const headers = resolveCursorRequestHeaders(baseOptions);

    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers.te).toBe("trailers");
    expect(headers.authorization).toBe("Bearer tok_abc");
    expect(headers["x-ghost-mode"]).toBe("true");
    expect(headers["x-cursor-client-version"]).toBe(CURSOR_CLIENT_VERSION);
    expect(headers["x-cursor-client-type"]).toBe(CURSOR_CLIENT_TYPE);
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("flips to application/proto for unary requests", () => {
    expect(resolveCursorRequestHeaders({ ...baseOptions, unary: false })["content-type"]).toBe(
      "application/connect+proto",
    );
    expect(resolveCursorRequestHeaders({ ...baseOptions, unary: true })["content-type"]).toBe(
      "application/proto",
    );
  });

  it("exposes the documented default cursor client version", () => {
    // Captured at module load; equals the documented fallback when the env var is unset.
    expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.05.01-eea359f");
    expect(CURSOR_CLIENT_TYPE).toBe("cli");
  });
});

// ── Fake node:http2 doubles ──

interface FakeH2Stream extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  closed: boolean;
  destroyed: boolean;
}

interface FakeH2Client extends EventEmitter {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
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

interface FakeHttpRequest extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
}

function createFakeHttpRequest(): FakeHttpRequest {
  const req = new EventEmitter() as FakeHttpRequest;
  req.write = vi.fn(() => true);
  req.end = vi.fn();
  req.destroy = vi.fn(() => {
    req.destroyed = true;
    return req;
  });
  req.destroyed = false;
  return req;
}

describe("createConnectBridgeHandle (HTTP/2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("produces a BridgeHandle over an injected http2 session", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });

    expect(connectSpy).toHaveBeenCalledWith("https://api2.cursor.sh");
    expect(client.request).toHaveBeenCalledOnce();
    const headers = client.request.mock.calls[0]![0] as Record<string, unknown>;
    expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
    expect(headers["content-type"]).toBe("application/connect+proto");

    const payload = Buffer.from("hello upstream");
    handle.write(payload);
    expect(stream.write).toHaveBeenCalled();
    // D1: transport ferries RAW bytes (proxy.ts pre-frames streaming writes),
    // matching the child bridge's wire contract exactly.
    expect((stream.write.mock.calls[0]![0] as Buffer).equals(payload)).toBe(true);

    expect(handle.alive).toBe(true);
    expect(typeof handle.proc.kill).toBe("function");
    connectSpy.mockRestore();
  });

  it("response Connect frames are delivered via onData", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    const received: Buffer[] = [];
    handle.onData((chunk) => received.push(Buffer.from(chunk)));

    const a = Buffer.from("aaa");
    const b = Buffer.from("bbbb");
    // Concatenated 5-byte-framed Connect messages, as they arrive on the wire.
    stream.emit("data", Buffer.concat([frameConnectMessage(a), frameConnectMessage(b)]));

    expect(received.map((x) => x.toString())).toEqual(["aaa", "bbbb"]);
    connectSpy.mockRestore();
  });

  it("end-stream error frame sets a non-zero close code", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    let closeCode: number | undefined;
    handle.onClose((code) => {
      closeCode = code;
    });

    const errJson = Buffer.from(
      JSON.stringify({ error: { code: "http_429", message: "rate limited" } }),
    );
    stream.emit("data", frameConnectMessage(errJson, CONNECT_END_STREAM_FLAG));
    stream.emit("close");

    expect(closeCode).toBe(1);
    connectSpy.mockRestore();
  });

  it("end-stream 429 is classified transient via the recorded error", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const handle: BridgeHandle = createConnectBridgeHandle(
      { accessToken: "tok_abc", rpcPath: "/agent.v1.AgentService/Run" },
      (event, data) => events.push({ event, data }),
    );
    let closeCode: number | undefined;
    handle.onClose((code) => {
      closeCode = code;
    });

    const errJson = Buffer.from(
      JSON.stringify({ error: { code: "http_429", message: "rate limited" } }),
    );
    stream.emit("data", frameConnectMessage(errJson, CONNECT_END_STREAM_FLAG));
    stream.emit("close");

    expect(closeCode).toBe(1);
    const classified = events.find((e) => e.event === "transport.error_classified");
    expect(classified).toBeDefined();
    expect(classified!.data?.kind).toBe("transient");
    expect(classified!.data?.retryable).toBe(true);
    expect(classified!.data?.httpStatus).toBe(429);
    connectSpy.mockRestore();
  });

  it("H2 transport sends PING every 30s and clears it on close", () => {
    vi.useFakeTimers();
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    client.ping.mockClear();

    vi.advanceTimersByTime(31_000);
    expect(client.ping).toHaveBeenCalledTimes(1);

    // Closing the stream clears the interval.
    stream.emit("close");
    client.ping.mockClear();
    vi.advanceTimersByTime(31_000);
    expect(client.ping).not.toHaveBeenCalled();

    connectSpy.mockRestore();
  });

  it("aborting the signal destroys the stream and closes", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const controller = new AbortController();
    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
      signal: controller.signal,
    });
    let closeCode: number | undefined;
    handle.onClose((code) => {
      closeCode = code;
    });
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    controller.abort();

    expect(stream.destroy).toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalled();
    expect(closeCode).toBe(1);
    // Listener removed (no leak).
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    connectSpy.mockRestore();
  });

  it("non-2xx HTTP status suppresses data and closes with a classified error", () => {
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const handle: BridgeHandle = createConnectBridgeHandle(
      { accessToken: "tok_abc", rpcPath: "/agent.v1.AgentService/Run" },
      (event, data) => events.push({ event, data }),
    );
    const received: Buffer[] = [];
    handle.onData((c) => received.push(Buffer.from(c)));
    let closeCode: number | undefined;
    handle.onClose((code) => {
      closeCode = code;
    });

    stream.emit("response", { ":status": 401 });
    stream.emit("data", Buffer.from("would-be-error-body"));
    stream.emit("close");

    // Error-status body is suppressed (no garbage reaches the consumer)...
    expect(received).toHaveLength(0);
    // ...and the close is classified + non-zero.
    expect(closeCode).toBe(1);
    const classified = events.find((e) => e.event === "transport.error_classified");
    expect(classified).toBeDefined();
    expect(classified!.data?.kind).toBe("auth");
    expect(classified!.data?.httpStatus).toBe(401);
    connectSpy.mockRestore();
  });
});

describe("createConnectBridgeHandle (HTTP/1.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PI_CURSOR_HTTP_1_1;
  });

  it("opens an https POST and ferries raw bytes (no pseudo-headers)", () => {
    const req = createFakeHttpRequest();
    const reqSpy = vi.spyOn(https, "request").mockReturnValue(req as never);
    process.env.PI_CURSOR_HTTP_1_1 = "1";

    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });

    expect(reqSpy).toHaveBeenCalledOnce();
    const opts = reqSpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe("/agent.v1.AgentService/Run");
    expect(opts.protocol).toBe("https:");
    expect(opts.hostname).toBe("api2.cursor.sh");
    expect(opts[":path"]).toBeUndefined(); // no HTTP/2 pseudo-headers
    expect(opts[":method"]).toBeUndefined();
    const headers = opts.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers.authorization).toBe("Bearer tok_abc");
    expect(headers["x-ghost-mode"]).toBe("true");

    // D1: raw ferry (proxy.ts pre-frames streaming writes).
    const payload = Buffer.from("hi-upstream");
    handle.write(payload);
    expect(req.write).toHaveBeenCalledOnce();
    expect((req.write.mock.calls[0]![0] as Buffer).equals(payload)).toBe(true);

    expect(handle.alive).toBe(true);
    handle.proc.kill();
    expect(req.destroy).toHaveBeenCalled();
    reqSpy.mockRestore();
  });

  it("response frames parse through the same parser as HTTP/2", () => {
    const req = createFakeHttpRequest();
    const res = new EventEmitter();
    const reqSpy = vi.spyOn(https, "request").mockReturnValue(req as never);
    process.env.PI_CURSOR_HTTP_1_1 = "1";

    const handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    const received: string[] = [];
    handle.onData((chunk) => received.push(chunk.toString()));

    // Simulate the HTTP/1.1 response arriving on the request emitter.
    req.emit("response", res);

    const a = Buffer.from("aa");
    const b = Buffer.from("bbb");
    res.emit("data", Buffer.concat([frameConnectMessage(a), frameConnectMessage(b)]));

    expect(received).toEqual(["aa", "bbb"]);
    reqSpy.mockRestore();
  });

  it("HTTP/1.1 fixture decodes to the same tokens as the H2 path", () => {
    const fixturePath = new URL(
      "./fixtures/bridge-frame-traces/h1.1-gpt-5.4.json",
      import.meta.url,
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      frames: { b64: string; len: number }[];
    };
    const expected = fixture.frames.map((f) => Buffer.from(f.b64, "base64"));

    // Reconstruct the Connect-framed wire bytes (5-byte header + payload, concatenated).
    const wireBytes = Buffer.concat(expected.map((p) => frameConnectMessage(p)));
    // Split mid-frame to exercise the parser's cross-chunk buffering on BOTH transports.
    const splitAt = Math.floor(wireBytes.length / 2) + 7;
    const chunk1 = wireBytes.subarray(0, splitAt);
    const chunk2 = wireBytes.subarray(splitAt);

    // --- HTTP/1.1 path ---
    const req = createFakeHttpRequest();
    const res = new EventEmitter();
    const h1Spy = vi.spyOn(https, "request").mockReturnValue(req as never);
    process.env.PI_CURSOR_HTTP_1_1 = "1";
    const h1Handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    const h1Received: Buffer[] = [];
    h1Handle.onData((c) => h1Received.push(Buffer.from(c)));
    req.emit("response", res);
    res.emit("data", Buffer.from(chunk1));
    res.emit("data", Buffer.from(chunk2));
    h1Spy.mockRestore();
    delete process.env.PI_CURSOR_HTTP_1_1;

    // --- HTTP/2 path (same bytes) ---
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const h2Spy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    const h2Handle: BridgeHandle = createConnectBridgeHandle({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    const h2Received: Buffer[] = [];
    h2Handle.onData((c) => h2Received.push(Buffer.from(c)));
    stream.emit("data", Buffer.from(chunk1));
    stream.emit("data", Buffer.from(chunk2));
    h2Spy.mockRestore();

    const eq = (a: Buffer[], b: Buffer[]): boolean =>
      a.length === b.length && a.every((buf, i) => buf.equals(b[i]!));
    // Both decode to the exact fixture payload sequence, byte-identical to each other.
    expect(eq(h1Received, expected)).toBe(true);
    expect(eq(h2Received, expected)).toBe(true);
    expect(eq(h1Received, h2Received)).toBe(true);
  });
});

describe("resolveBridgeFactory (PI_CURSOR_TRANSPORT)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PI_CURSOR_TRANSPORT;
    delete process.env.PI_CURSOR_PROVIDER_DEBUG;
    delete process.env.PI_CURSOR_PROVIDER_DEBUG_FILE;
  });

  it("default factory is in-process unless PI_CURSOR_TRANSPORT=child", () => {
    // Default (unset / unknown) → in-process transport opens an http2 session.
    delete process.env.PI_CURSOR_TRANSPORT;
    const stream = createFakeH2Stream();
    const client = createFakeH2Client(stream);
    const connectSpy = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    const defaultFactory = resolveBridgeFactory();
    const handle = defaultFactory({
      accessToken: "tok_abc",
      rpcPath: "/agent.v1.AgentService/Run",
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(handle.alive).toBe(true);
    handle.proc.kill();
    connectSpy.mockRestore();

    // Unknown value also falls through to in-process (not child).
    process.env.PI_CURSOR_TRANSPORT = "foo";
    const connectSpy2 = vi.spyOn(http2, "connect").mockReturnValue(client as never);
    resolveBridgeFactory()({ accessToken: "tok", rpcPath: "/x" });
    expect(connectSpy2).toHaveBeenCalledTimes(1);
    connectSpy2.mockRestore();

    // child mode routes through the (mocked) child-process bridge.
    process.env.PI_CURSOR_TRANSPORT = "child";
    const childFactory = resolveBridgeFactory();
    const fakeChildHandle: BridgeHandle = {
      proc: { kill: () => true },
      alive: true,
      write: () => {},
      end: () => {},
      onData: () => {},
      onClose: () => {},
    };
    const spawnSpy = vi.spyOn(bridge, "spawnBridge").mockReturnValue(fakeChildHandle);
    const h = childFactory({ accessToken: "tok", rpcPath: "/x" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(h).toBe(fakeChildHandle);
    spawnSpy.mockRestore();
  });

  it("child transport emits a deprecation debug event", () => {
    const debugFile = joinPath(
      tmpdir(),
      `pi-cursor-deprec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
    process.env.PI_CURSOR_TRANSPORT = "child";
    process.env.PI_CURSOR_PROVIDER_DEBUG = "1";
    process.env.PI_CURSOR_PROVIDER_DEBUG_FILE = debugFile;
    const fakeChildHandle: BridgeHandle = {
      proc: { kill: () => true },
      alive: true,
      write: () => {},
      end: () => {},
      onData: () => {},
      onClose: () => {},
    };
    const spawnSpy = vi.spyOn(bridge, "spawnBridge").mockReturnValue(fakeChildHandle);

    const factory = resolveBridgeFactory();
    const h = factory({ accessToken: "tok", rpcPath: "/agent.v1.AgentService/Run" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(h).toBe(fakeChildHandle);

    const events = readFileSync(debugFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deprec = events.find((e) => e.event === "transport.deprecated_child");
    expect(deprec).toBeDefined();
    expect(String(deprec!.reason)).toContain("PI_CURSOR_TRANSPORT=child");

    try {
      unlinkSync(debugFile);
    } catch {}
    spawnSpy.mockRestore();
  });
});

describe("resolveTransportMode (PI_CURSOR_HTTP_1_1)", () => {
  it("toggles HTTP/1.1 by PI_CURSOR_HTTP_1_1 (allowlist, default-deny)", () => {
    const on = (v: string): boolean =>
      resolveTransportMode({ PI_CURSOR_HTTP_1_1: v } as NodeJS.ProcessEnv).useHttp1;

    // Truthy (allowlist).
    expect(on("1")).toBe(true);
    expect(on("true")).toBe(true);
    expect(on("on")).toBe(true);
    expect(on("yes")).toBe(true);
    expect(on("enabled")).toBe(true);
    expect(on("TRUE")).toBe(true); // case-insensitive
    expect(on("  On  ")).toBe(true); // whitespace-insensitive

    // Falsy.
    expect(on("")).toBe(false);
    expect(on("0")).toBe(false);
    expect(on("false")).toBe(false);
    expect(on("off")).toBe(false);
    expect(on("no")).toBe(false);
    expect(on("disabled")).toBe(false);

    // Unknown → default-deny (D2).
    expect(on("maybe")).toBe(false);
  });

  it("defaults to HTTP/2 when the env var is absent", () => {
    expect(resolveTransportMode({}).useHttp1).toBe(false);
  });
});
