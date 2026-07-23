import http2 from "node:http2";

import type { BridgeDebugLog, BridgeHandle, SpawnBridgeOptions } from "./bridge.js";
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

  const fireClose = (code: number): void => {
    if (closed) return;
    closed = true;
    onCloseCb?.(code);
  };

  // Inbound data is wired raw here; S-13 routes it through createConnectFrameParser
  // so decoded Connect messages (and end-stream errors) surface via onData/onClose.
  h2Stream.on("data", (chunk: Buffer) => {
    onDataCb?.(chunk);
  });
  h2Stream.on("close", () => fireClose(0));
  client.on("close", () => fireClose(0));
  h2Stream.on("error", (err) => {
    debugLog("transport.h2.stream_error", {
      rpcPath: options.rpcPath,
      message: err instanceof Error ? err.message : String(err),
    });
    fireClose(1);
  });
  client.on("error", (err) => {
    debugLog("transport.h2.client_error", {
      rpcPath: options.rpcPath,
      message: err instanceof Error ? err.message : String(err),
    });
    fireClose(1);
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
      if (unary) {
        unaryBuffer.push(Buffer.from(data));
        return;
      }
      h2Stream.write(Buffer.from(data));
    },
    end(): void {
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
