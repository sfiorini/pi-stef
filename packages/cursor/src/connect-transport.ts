import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import https from "node:https";

import type { BridgeDebugLog, BridgeHandle, SpawnBridgeOptions } from "./bridge.js";
import {
  type ConnectEndStreamError,
  createConnectFrameParser,
  parseConnectEndStreamDetailed,
} from "./bridge.js";
import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
  resolveCursorRequestHeaders,
} from "./cursor-request-headers.js";
import { attachClassification, classifyTransportError } from "./transport-errors.js";

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
  /** Most recent HTTP response status, if headers were received (for classification). */
  getResponseStatus(): number | undefined;
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
  debugLog: BridgeDebugLog,
): BridgeHandle {
  const unary = options.unary ?? false;
  const unaryBuffer: Buffer[] = [];

  let onDataCb: ((chunk: Buffer) => void) | null = null;
  let onCloseCb: ((code: number) => void) | null = null;
  let closed = false;
  let lastError: (Error & { kind?: string; retryable?: boolean }) | null = null;
  let removeAbortListener: () => void = () => {};

  const fireClose = (forceCode?: number): void => {
    if (closed) return;
    closed = true;
    removeAbortListener();
    onCloseCb?.(forceCode ?? (lastError ? 1 : 0));
  };

  // Classify an error using the captured HTTP status + Connect code, stamp the
  // kind onto it, surface it via debug, and record it as lastError.
  const recordClassifiedError = (
    err: Error,
    connectCode?: string,
    httpStatusOverride?: number,
  ): void => {
    const httpStatus = httpStatusOverride ?? adapter.getResponseStatus();
    const classification = classifyTransportError({ error: err, httpStatus, connectCode });
    attachClassification(err, classification);
    debugLog("transport.error_classified", {
      rpcPath: options.rpcPath,
      kind: classification.kind,
      retryable: classification.retryable,
      httpStatus,
      connectCode,
      message: err.message,
    });
    if (!lastError) lastError = err;
  };

  // Decode Connect framing on the inbound byte stream: normal messages → onData;
  // the 0b00000010 end-stream frame carries a (possibly null) Connect error that
  // is classified (S-31) and surfaced as a structured non-zero close.
  const parseIncoming = createConnectFrameParser(
    (messageBytes: Uint8Array) => {
      onDataCb?.(Buffer.from(messageBytes));
    },
    (endStreamBytes: Uint8Array) => {
      const { error: endError } = parseConnectEndStreamDetailed(endStreamBytes);
      if (endError) {
        const typed = endError as ConnectEndStreamError;
        recordClassifiedError(endError, typed.code, typed.httpStatus);
      }
      try {
        adapter.destroy();
      } catch {}
    },
  );

  adapter.onInbound((chunk) => parseIncoming(chunk));
  adapter.onClose(fireClose);
  adapter.onError((err) => {
    recordClassifiedError(err);
    fireClose();
  });

  // Abort propagation (S-33): tearing the transport down on abort ensures the
  // upstream HTTP stream is fully RST'd, not just half-closed by proxy.ts's
  // graceful cancel (cleanupBridge sends a cancel action + ends the write side).
  const signal = options.signal;
  if (signal) {
    const onAbort = (): void => {
      debugLog("transport.aborted", { rpcPath: options.rpcPath });
      try {
        adapter.destroy();
      } catch {}
      fireClose(1);
    };
    if (signal.aborted) {
      // Already aborted before listeners could attach — fire on a later tick.
      queueMicrotask(onAbort);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  }

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
    get lastError(): (Error & { kind?: string; retryable?: boolean }) | null {
      return lastError;
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
  let responseStatus: number | undefined;
  h2Stream.on("response", (responseHeaders) => {
    const status = Number(responseHeaders[":status"] ?? 0);
    responseStatus = status > 0 ? status : undefined;
  });

  // H2 PING keepalive: keep the TCP/TLS/H2 session alive through idle network
  // middleboxes (the real cause of dropped idle connections). Does NOT reset the
  // application idle watchdog — that resets only on real upstream data delivered
  // via onData (see proxy.ts createStreamIdleWatchdog). Ack errors are swallowed.
  const pingTimer = setInterval(() => {
    if (!client.destroyed) {
      client.ping(() => {
        /* ignore ack errors */
      });
    }
  }, 30_000);
  (pingTimer as { unref?: () => void }).unref?.();
  const stopPing = (): void => clearInterval(pingTimer);

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
      const done = (): void => {
        stopPing();
        cb();
      };
      h2Stream.on("close", () => {
        try {
          client.close();
        } catch {}
        done();
      });
      client.on("close", done);
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
    getResponseStatus() {
      return responseStatus;
    },
    isAlive() {
      return !client.closed && !h2Stream.destroyed;
    },
    destroy() {
      stopPing();
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
  let responseStatus: number | undefined;
  // No PING keepalive needed for HTTP/1.1: chunked transfer-encoding keep-alive
  // is automatic. The H2 PING (http2Adapter) addresses middlebox idle drops.

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
        responseStatus = res.statusCode;
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
    getResponseStatus() {
      return responseStatus;
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
  return buildBridgeHandle(options, adapter, debugLog);
}
