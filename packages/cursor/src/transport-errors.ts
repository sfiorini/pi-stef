/**
 * Transport error classification for the in-process Cursor Connect transport.
 *
 * Replaces the legacy child bridge's blanket `process.exit(1)`-on-any-error with
 * a triaged signal: {@link classifyTransportError} maps an HTTP status, a Connect
 * error code, and/or a Node error message to one of three kinds. The existing
 * idle-retry controller in `proxy.ts` consumes the resulting non-zero close;
 * {@link S-34} (auth refresh) consumes the `auth` kind.
 */

export type TransportErrorKind = "transient" | "auth" | "fatal";

export interface TransportErrorClassification {
  kind: TransportErrorKind;
  retryable: boolean;
}

export interface ClassifyTransportErrorInput {
  error?: Error | null;
  httpStatus?: number;
  connectCode?: string;
}

const TRANSIENT_CONNECT_CODES = new Set([
  "canceled",
  "deadline_exceeded",
  "unavailable",
  "resource_exhausted",
]);

const TRANSIENT_MESSAGE = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|RST_STREAM)/i;
const AUTH_MESSAGE = /unauthor|forbidden|token.*expir/i;

/**
 * Classify a transport error. Default-deny: anything not recognizably transient
 * or auth-related is `fatal` (so the user gets a clear terminal error instead of
 * an infinite retry loop).
 *
 * @param input.error     The underlying Error (stream/client error or parsed
 *                        Connect end-stream error). Its message is pattern-matched.
 * @param input.httpStatus HTTP response status (H2 `:status` / H1.1 `statusCode`,
 *                        or extracted from a child-style `http_<n>` Connect code).
 * @param input.connectCode Connect end-stream error code (e.g. `unavailable`).
 */
export function classifyTransportError(
  input: ClassifyTransportErrorInput,
): TransportErrorClassification {
  const { httpStatus, connectCode } = input;
  const message = input.error?.message ?? "";

  if (httpStatus === 401 || httpStatus === 403 || AUTH_MESSAGE.test(message)) {
    return { kind: "auth", retryable: true };
  }
  if (httpStatus !== undefined && (httpStatus === 429 || httpStatus >= 500)) {
    return { kind: "transient", retryable: true };
  }
  if (connectCode && TRANSIENT_CONNECT_CODES.has(connectCode)) {
    return { kind: "transient", retryable: true };
  }
  if (message && TRANSIENT_MESSAGE.test(message)) {
    return { kind: "transient", retryable: true };
  }
  return { kind: "fatal", retryable: false };
}

/**
 * Stamp a classification onto an Error so downstream consumers (e.g. the S-34
 * auth-retry path) can read `err.kind` / `err.retryable`. Returns the same Error.
 */
export function attachClassification(
  err: Error,
  classification: TransportErrorClassification,
): Error & TransportErrorClassification {
  const stamped = err as Error & TransportErrorClassification;
  stamped.kind = classification.kind;
  stamped.retryable = classification.retryable;
  return stamped;
}
