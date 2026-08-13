import { describe, it, expect } from "vitest";
import {
  RateLimitError,
  AuthExpiredError,
  ServerError,
  ClientError,
  NetworkError,
  UnknownError,
  QwenUpstreamError,
  EmptyCompletionError,
} from "../src/upstream/errors";

describe("error classes", () => {
  it("NetworkError is retryable and constructed directly", () => {
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

describe("EmptyCompletionError", () => {
  it("is a QwenUpstreamError with retryable=true, name, and message", () => {
    const err = new EmptyCompletionError("empty completion");
    expect(err).toBeInstanceOf(QwenUpstreamError);
    expect(err).toBeInstanceOf(Error);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("EmptyCompletionError");
    expect(err.message).toBe("empty completion");
  });

  it("has status undefined (semantic, not HTTP-classified)", () => {
    const err = new EmptyCompletionError("empty");
    expect(err.status).toBeUndefined();
  });
});
