import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import https from "node:https";

import type { BridgeDebugLog, BridgeHandle, SpawnBridgeOptions } from "./bridge.js";
import { createConnectFrameParser, parseConnectEndStream } from "./bridge.js";
import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
  resolveCursorRequestHeaders,
} from "./cursor-request-headers.js";

/**
 * Default Cursor agent endpoint. Mirrors `bridge.ts` / `proxy.ts` defaults;
 * `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` overrides are resolved upstream by
 * `getCursorAgentUrl()` and passed in via `options.url`.
 */
const DEFAULT_CURSOR_URL = "https://api2.cursor.sh";

function noopDebugLog(): void {}

/**
 * Resolved transport selection. `useHttp1` selects the HTTP/1.1+SSE transport
 * (the proven escape hatch for VPN/proxy/broken-HTTP2 environments, mirroring
 * `@cursor/sdk`'s `useHttp1ForAgent`).
 */
export interface TransportMode {
  useHttp1: boolean;
}

/** Allowlist of truthy values for `PI_CURSOR_HTTP_1_1` (default-deny, D2). */
const HTTP_1_1_TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);

/**
 * Resolve the transport mode from `PI_CURSOR_HTTP_1_1`. Truthy values are an
 * explicit allowlist (1/true/on/yes/enabled); everything else — including
 * unknown strings like "maybe" and all falsy values — is default-deny
 * (HTTP/2). Case- and whitespace-insensitive.
 */
export function resolveTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  const raw = (env.PI_CURSOR_HTTP_1_1 ?? "").trim().toLowerCase();
  return { useHttp1: HTTP_1_1_TRUTHY.has(raw) };
}

/**
 * Minimal outbound stream surface shared by the HTTP/2 and HTTP/1.1 branches.
 * Both transports ferry RAW bytes (D1): `proxy.ts` already pre-frames streaming
 * writes via `frameConnectMessage(...)`, so the transport does NOT re-frame.
 */
interface OutboundStream {
  write(data: Buffer): void;
  end(data?: Buffer): void;
  readonly destroyed: boolean;
}

/**
 * Adapter that abstracts the underlying transport (HTTP/2 stream/session vs.
 * HTTP/1.1 request/response) so the framing/error/close logic is shared.
 */
interface StreamAdapter {
  readonly outbound: OutboundStream;
  /** Subscribe to inbound (response) bytes, already de-chunked by the transport. */
  onInbound(cb: (chunk: Buffer) => void): void;
  /** Subscribe to the underlying transport closing (normal completion). */
  onClose(cb: () => void): void;
  /** Subscribe to transport-level errors. */
  onError(cb: (err: Error) => void): void;
  /** Whether the transport is still usable (not closed/destroyed). */
  isAlive(): boolean;
  /** Tear down the underlying transport (idempotent). */
  destroy(): void;
}

function logError(
  debugLog: BridgeDebugLog,
  event: string,
  options: SpawnBridgeOptions,
  err: unknown,
): void {
  debugLog(event, {
    rpcPath: options.rpcPath,
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Build a {@link BridgeHandle} from a {@link StreamAdapter}. Owns the shared
 * Connect framing parser, the double-close guard, the `lastError`→close-code
 * mapping, and the raw-ferry write/end semantics (D1).
 */
function buildBridgeHandle(
  options: SpawnBridgeOptions,
  adapter: StreamAdapter,
): BridgeHandle {
  const unary = options.unary ?? false;
  const unaryBuffer: Buffer[] = [];

  let onDataCb: ((chunk: Buffer) => void) | null = null;
  let onCloseCb: ((code: number) => void) | null = null;
  let closed = false;
  let lastError: Error | null = null;

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    onCloseCb?.(lastError ? 1 : 0);
  };

  // Decode Connect framing on the inbound byte stream: normal messages → onData;
  // the 0b00000010 end-stream frame carries a (possibly null) Connect error that
  // becomes a structured non-zero close via lastError. The end-stream frame is
  // terminal, so tear the transport down to surface onClose promptly.
  const parseIncoming = createConnectFrameParser(
    (messageBytes: Uint8Array) => {
      onDataCb?.(Buffer.from(messageBytes));
    },
    (endStreamBytes: Uint8Array) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) lastError = endError;
      try {
        adapter.destroy();
      } catch {}
    },
  );

  adapter.onInbound((chunk) => parseIncoming(chunk));
  adapter.onClose(fireClose);
  adapter.onError((err) => {
    lastError = lastError ?? err;
    fireClose();
  });

  return {
    proc: {
      kill: (): boolean => {
        try {
          adapter.destroy();
        } catch {}
        return true;
      },
    },
    get alive(): boolean {
      return adapter.isAlive();
    },
    write(data: Uint8Array): void {
      if (closed || adapter.outbound.destroyed) return;
      if (unary) {
        unaryBuffer.push(Buffer.from(data));
        return;
      }
      adapter.outbound.write(Buffer.from(data));
    },
    end(): void {
      if (closed || adapter.outbound.destroyed) return;
      if (unary && unaryBuffer.length > 0) {
        adapter.outbound.end(Buffer.concat(unaryBuffer));
      } else {
        adapter.outbound.end();
      }
    },
    onData(cb: (chunk: Buffer) => void): void {
      onDataCb = cb;
    },
    onClose(cb: (code: number) => void): void {
      onCloseCb = cb;
    },
  };
}

/** HTTP/2 transport adapter (default). */
function http2Adapter(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
): StreamAdapter {
  const baseUrl = (options.url ?? DEFAULT_CURSOR_URL).replace(/\/+$/, "");
  const client = http2.connect(baseUrl);
  const headers = resolveCursorRequestHeaders(options);
  const h2Stream = client.request(headers);

  return {
    outbound: {
      write: (data: Buffer) => {
        h2Stream.write(data);
      },
      end: (data?: Buffer) => {
        if (data) h2Stream.end(data);
        else h2Stream.end();
      },
      get destroyed(): boolean {
        return h2Stream.destroyed;
      },
    },
    onInbound(cb) {
      h2Stream.on("data", cb);
    },
    onClose(cb) {
      h2Stream.on("close", () => {
        try {
          client.close();
        } catch {}
        cb();
      });
      client.on("close", cb);
    },
    onError(cb) {
      h2Stream.on("error", (err) => {
        logError(debugLog, "transport.h2.stream_error", options, err);
        cb(err instanceof Error ? err : new Error(String(err)));
      });
      client.on("error", (err) => {
        logError(debugLog, "transport.h2.client_error", options, err);
        cb(err instanceof Error ? err : new Error(String(err)));
      });
    },
    isAlive() {
      return !client.closed && !h2Stream.destroyed;
    },
    destroy() {
      try {
        h2Stream.destroy();
      } catch {}
      try {
        client.destroy();
      } catch {}
    },
  };
}

/** HTTP/1.1+SSE transport adapter (selected by `PI_CURSOR_HTTP_1_1`). */
function http1Adapter(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
): StreamAdapter {
  const baseUrl = (options.url ?? DEFAULT_CURSOR_URL).replace(/\/+$/, "");
  const url = new URL(baseUrl);
  const unary = options.unary ?? false;

  const req = https.request({
    method: "POST",
    protocol: "https:",
    hostname: url.hostname,
    path: options.rpcPath,
    headers: {
      "content-type": unary ? "application/proto" : "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: `Bearer ${options.accessToken}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": CURSOR_CLIENT_TYPE,
      "x-request-id": randomUUID(),
    },
  });

  let responseFinished = false;

  return {
    outbound: {
      write: (data: Buffer) => {
        req.write(data);
      },
      end: (data?: Buffer) => {
        if (data) req.end(data);
        else req.end();
      },
      get destroyed(): boolean {
        return req.destroyed;
      },
    },
    onInbound(cb) {
      // HTTP/1.1 has no pseudo-headers; chunked transfer-encoding delivers the
      // response body, which is the SAME Connect frame stream as HTTP/2.
      req.on("response", (res) => {
        res.on("data", (chunk: Buffer) => cb(chunk));
        res.on("end", () => {
          responseFinished = true;
        });
      });
    },
    onClose(cb) {
      req.on("close", cb);
    },
    onError(cb) {
      req.on("error", (err) => {
        logError(debugLog, "transport.h1.request_error", options, err);
        cb(err instanceof Error ? err : new Error(String(err)));
      });
    },
    isAlive() {
      return !req.destroyed && !responseFinished;
    },
    destroy() {
      try {
        req.destroy();
      } catch {}
    },
  };
}

/**
 * In-process Connect transport over Node `http2` (default) or `https`
 * (HTTP/1.1+SSE when `PI_CURSOR_HTTP_1_1` is set). Replaces the legacy
 * child-process `h2-bridge.mjs` substrate (which `process.exit(1)`-ed on any
 * error / a 120s idle timer). Conforms exactly to the existing
 * {@link BridgeHandle} contract so `proxy.ts` is unchanged except for factory
 * selection.
 *
 * Error handling is refined by S-31 (classification), S-32 (PING keepalive) and
 * S-33 (abort propagation).
 */
export function createConnectBridgeHandle(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  const { useHttp1 } = resolveTransportMode();
  const adapter = useHttp1 ? http1Adapter(options, debugLog) : http2Adapter(options, debugLog);
  return buildBridgeHandle(options, adapter);
}
