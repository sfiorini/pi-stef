import http2 from "node:http2";

import type { BridgeDebugLog, BridgeHandle, SpawnBridgeOptions } from "./bridge.js";
import {
  createConnectFrameParser,
  parseConnectEndStream,
} from "./bridge.js";
import { resolveCursorRequestHeaders } from "./cursor-request-headers.js";

/**
 * Default Cursor agent endpoint. Mirrors `bridge.ts` / `proxy.ts` defaults;
 * `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` overrides are resolved upstream by
 * `getCursorAgentUrl()` and passed in via `options.url`.
 */
const DEFAULT_CURSOR_URL = "https://api2.cursor.sh";

function noopDebugLog(): void {}

/**
 * In-process Connect transport over Node `http2`.
 *
 * This replaces the legacy child-process `h2-bridge.mjs` substrate (which
 * `process.exit(1)`-ed on any error / a 120s idle timer). It conforms exactly
 * to the existing {@link BridgeHandle} contract so `proxy.ts` is unchanged
 * except for factory selection (see `resolveBridgeFactory`).
 *
 * Framing model (D1): the transport ferries RAW bytes to the HTTP/2 stream,
 * byte-identical to the child bridge. `proxy.ts` already pre-frames streaming
 * writes via `frameConnectMessage(...)`; the transport does NOT re-frame.
 *
 * Error handling is intentionally minimal here (onClose with a non-zero code).
 * It is refined by S-31 (classification), S-32 (PING keepalive) and S-33
 * (abort propagation).
 */
export function createConnectBridgeHandle(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  const baseUrl = (options.url ?? DEFAULT_CURSOR_URL).replace(/\/+$/, "");
  const client = http2.connect(baseUrl);
  const headers = resolveCursorRequestHeaders(options);
  const h2Stream = client.request(headers);

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

  // Decode the Connect framing on the inbound byte stream: normal messages →
  // onData; the 0b00000010 end-stream frame carries a (possibly null) Connect
  // error that becomes a structured non-zero close via lastError.
  const parseIncoming = createConnectFrameParser(
    (messageBytes: Uint8Array) => {
      onDataCb?.(Buffer.from(messageBytes));
    },
    (endStreamBytes: Uint8Array) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) lastError = endError;
      try {
        h2Stream.end();
      } catch {}
    },
  );

  h2Stream.on("data", (chunk: Buffer) => {
    parseIncoming(chunk);
  });
  h2Stream.on("close", () => {
    try {
      client.close();
    } catch {}
    fireClose();
  });
  client.on("close", () => fireClose());
  h2Stream.on("error", (err) => {
    debugLog("transport.h2.stream_error", {
      rpcPath: options.rpcPath,
      message: err instanceof Error ? err.message : String(err),
    });
    lastError = lastError ?? err;
    fireClose();
  });
  client.on("error", (err) => {
    debugLog("transport.h2.client_error", {
      rpcPath: options.rpcPath,
      message: err instanceof Error ? err.message : String(err),
    });
    lastError = lastError ?? err;
    fireClose();
  });

  return {
    proc: {
      kill: (): boolean => {
        try {
          h2Stream.destroy();
        } catch {}
        try {
          client.destroy();
        } catch {}
        return true;
      },
    },
    get alive(): boolean {
      return !client.closed && !h2Stream.destroyed;
    },
    write(data: Uint8Array): void {
      if (closed || h2Stream.destroyed) return;
      if (unary) {
        unaryBuffer.push(Buffer.from(data));
        return;
      }
      h2Stream.write(Buffer.from(data));
    },
    end(): void {
      if (closed || h2Stream.destroyed) return;
      if (unary && unaryBuffer.length > 0) {
        h2Stream.end(Buffer.concat(unaryBuffer));
      } else {
        h2Stream.end();
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
