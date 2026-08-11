import { describe, it, expect } from "vitest";
import {
  classifyResponse,
  RateLimitError,
  AuthExpiredError,
  ServerError,
  ClientError,
  NetworkError,
  UnknownError,
  QwenUpstreamError,
} from "../src/upstream/errors";

function headers(obj: Record<string, string> = {}): Headers {
  return new Headers(obj);
}

describe("classifyResponse", () => {
  it("429 + Retry-After: 30 → RateLimitError (retryable, retryAfterMs=30000)", () => {
    const err = classifyResponse(429, "", headers({ "retry-after": "30" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30000);
    expect(err.status).toBe(429);
  });

  it("429 + body 'rate limit exceeded' → RateLimitError (retryable)", () => {
    const err = classifyResponse(
      429,
      '{"error":"rate limit exceeded"}',
      headers(),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
  });

  it("429 + body 'quota exhausted' → RateLimitError", () => {
    const err = classifyResponse(429, "quota exhausted", headers());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
  });

  it("429 + body 'insufficient_quota' → RateLimitError", () => {
    const err = classifyResponse(429, "insufficient_quota", headers());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
  });

  it("429 + body 'too many requests' → RateLimitError", () => {
    const err = classifyResponse(429, "too many requests", headers());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
  });

  it("429 + Retry-After HTTP-date → RateLimitError (retryAfterMs undefined)", () => {
    const err = classifyResponse(
      429,
      "",
      headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("401 → AuthExpiredError (retryable)", () => {
    const err = classifyResponse(401, '{"error":"unauthorized"}', headers());
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(401);
  });

  it("400 → ClientError (retryable=false)", () => {
    const err = classifyResponse(400, '{"error":"bad request"}', headers());
    expect(err).toBeInstanceOf(ClientError);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
  });

  it("403 → ClientError (retryable=false)", () => {
    const err = classifyResponse(403, "forbidden", headers());
    expect(err).toBeInstanceOf(ClientError);
    expect(err.retryable).toBe(false);
  });

  it("404 → ClientError (retryable=false)", () => {
    const err = classifyResponse(404, "not found", headers());
    expect(err).toBeInstanceOf(ClientError);
    expect(err.retryable).toBe(false);
  });

  it("500 → ServerError (retryable=true)", () => {
    const err = classifyResponse(500, '{"error":"internal"}', headers());
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
  });

  it("502 → ServerError (retryable=true)", () => {
    const err = classifyResponse(502, "", headers());
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it("503 → ServerError (retryable=true)", () => {
    const err = classifyResponse(503, "", headers());
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it("418 → UnknownError (retryable=false)", () => {
    const err = classifyResponse(418, "I'm a teapot", headers());
    expect(err).toBeInstanceOf(UnknownError);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(418);
  });

  it("preserves body text on the error", () => {
    const err = classifyResponse(500, "something broke", headers());
    expect(err.body).toBe("something broke");
  });

  it("NetworkError is retryable and constructed directly (not via classifyResponse)", () => {
    const err = new NetworkError("fetch failed", {
      status: undefined,
      body: undefined,
    });
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toBeInstanceOf(QwenUpstreamError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBeUndefined();
  });

  it("all error classes extend QwenUpstreamError", () => {
    const cases = [
      new RateLimitError("rl"),
      new AuthExpiredError("auth"),
      new ServerError("srv"),
      new ClientError("cli"),
      new NetworkError("net"),
      new UnknownError("unk"),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(QwenUpstreamError);
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.retryable).toBe("boolean");
    }
  });
});
