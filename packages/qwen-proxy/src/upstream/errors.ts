/**
 * 6-category error classifier for upstream Qwen API responses.
 * classifyResponse maps HTTP status codes to typed, retryable error objects.
 */

export abstract class QwenUpstreamError extends Error {
  abstract readonly retryable: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts?: { status?: number; body?: string; retryAfterMs?: number },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts?.status;
    this.body = opts?.body;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export class RateLimitError extends QwenUpstreamError {
  readonly retryable = true;
}

export class AuthExpiredError extends QwenUpstreamError {
  readonly retryable = true;
}

export class ServerError extends QwenUpstreamError {
  readonly retryable = true;
}

export class ClientError extends QwenUpstreamError {
  readonly retryable = false;
}

export class NetworkError extends QwenUpstreamError {
  readonly retryable = true;
}

export class UnknownError extends QwenUpstreamError {
  readonly retryable = false;
}

/** Empty completion (HTTP 200, no payload — likely a Baxia CAPTCHA flag).
 *  Surfaced by chatCompletionsNonStream; caught by withPoolRetry's inline
 *  retry loop. Semantic signal — NOT produced by classifyResponse. */
export class EmptyCompletionError extends QwenUpstreamError {
  readonly retryable = true;
}

/** Parse `Retry-After` header: integer seconds → ms; HTTP-date → undefined. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // HTTP-date or non-integer — leave undefined
  return undefined;
}

const RATE_LIMIT_RE =
  /quota exhausted|insufficient_quota|too many requests|rate limit/i;

/**
 * Map an HTTP response into one of the 6 typed upstream errors.
 * NetworkError is NOT produced here — it is thrown directly by the client
 * when fetch() throws or times out.
 */
export function classifyResponse(
  status: number,
  bodyText: string,
  headers: Headers,
): QwenUpstreamError {
  switch (status) {
    case 429: {
      const retryAfterMs =
        RATE_LIMIT_RE.test(bodyText) || headers.get("retry-after")
          ? parseRetryAfterMs(headers.get("retry-after"))
          : undefined;
      return new RateLimitError("Rate limited", {
        status,
        body: bodyText,
        retryAfterMs,
      });
    }
    case 401:
      return new AuthExpiredError("Authentication expired", {
        status,
        body: bodyText,
      });
    case 400:
    case 403:
    case 404:
      return new ClientError(`Client error ${status}`, {
        status,
        body: bodyText,
      });
    case 500:
    case 502:
    case 503:
      return new ServerError(`Server error ${status}`, {
        status,
        body: bodyText,
      });
    default:
      return new UnknownError(`Unknown error ${status}`, {
        status,
        body: bodyText,
      });
  }
}
