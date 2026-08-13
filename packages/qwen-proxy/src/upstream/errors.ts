/**
 * Typed upstream error classes for Qwen API responses.
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
 *  retry loop. Semantic signal. */
export class EmptyCompletionError extends QwenUpstreamError {
  readonly retryable = true;
}
