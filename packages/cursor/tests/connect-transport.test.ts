import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
  resolveCursorRequestHeaders,
} from "../src/cursor-request-headers";
import { type BridgeHandle } from "../src/bridge";
import { createConnectBridgeHandle } from "../src/connect-transport";

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

describe("createConnectBridgeHandle (HTTP/2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
