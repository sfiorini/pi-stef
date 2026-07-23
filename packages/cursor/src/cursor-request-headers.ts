import { randomUUID } from "node:crypto";

import type { SpawnBridgeOptions } from "./bridge.js";

/**
 * Cursor CLI client version advertised on every RPC. Mirrors the value the
 * legacy `h2-bridge.mjs` shipped; overridable via `PI_CURSOR_CLIENT_VERSION`.
 * Captured at module load to match the legacy child-bridge behavior.
 */
export const CURSOR_CLIENT_VERSION =
  process.env.PI_CURSOR_CLIENT_VERSION || "cli-2026.05.01-eea359f";

/** Cursor client type advertised on every RPC. */
export const CURSOR_CLIENT_TYPE = "cli";

/**
 * The exact header contract Cursor's Connect-over-HTTP/2 agent endpoint
 * expects. Reverse-engineered and shared by the legacy `h2-bridge.mjs`;
 * centralized here so the in-process transport and any future transport stay
 * in sync (header drift becomes a compile error).
 */
export interface CursorRequestHeaders {
  ":method": "POST";
  ":path": string;
  "content-type": "application/connect+proto" | "application/proto";
  "connect-protocol-version": "1";
  te: "trailers";
  authorization: string;
  "x-ghost-mode": "true";
  "x-cursor-client-version": string;
  "x-cursor-client-type": string;
  "x-request-id": string;
  /** Index signature enables direct assignability to `http2.OutgoingHttpHeaders`. */
  readonly [header: string]: string;
}

/**
 * Resolve the Cursor Connect request headers for one RPC.
 *
 * @precondition `options.accessToken` MUST be non-empty. The caller
 *   (`proxy.ts`) throws "Not logged in" before reaching the transport when no
 *   token is available, so an empty token here surfaces as `Bearer ` only when
 *   the provider is misconfigured upstream.
 */
export function resolveCursorRequestHeaders(
  options: SpawnBridgeOptions,
): CursorRequestHeaders {
  const unary = options.unary ?? false;
  return {
    ":method": "POST",
    ":path": options.rpcPath,
    "content-type": unary ? "application/proto" : "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${options.accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": CURSOR_CLIENT_TYPE,
    "x-request-id": randomUUID(),
  };
}
