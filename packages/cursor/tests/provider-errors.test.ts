import { describe, expect, it, vi } from "vitest";

// Mock @cursor/sdk error classes for the test — we need them as constructors
// so instanceof checks work without actually importing the real SDK in every test.
// sdk-runtime.test.ts is the ONLY test that touches the real SDK.

class FakeAuthenticationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthenticationError";
  }
}
class FakeRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RateLimitError";
  }
}
class FakeAgentBusyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentBusyError";
  }
}
class FakeNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NetworkError";
  }
}

vi.mock("../src/sdk-runtime", () => ({
  loadCursorSdk: vi.fn(async () => ({
    AuthenticationError: FakeAuthenticationError,
    RateLimitError: FakeRateLimitError,
    AgentBusyError: FakeAgentBusyError,
    NetworkError: FakeNetworkError,
  })),
}));

import { classifyCursorError, isAbortError } from "../src/provider-errors";

describe("classifyCursorError", () => {
  it("classifies AuthenticationError as 'auth'", async () => {
    const err = new FakeAuthenticationError("Invalid API key crsr_test123key456value789");
    const result = await classifyCursorError(err);
    expect(result.reason).toBe("auth");
    // Must scrub the secret
    expect(result.message).not.toContain("crsr_test123key456value789");
  });

  it("classifies RateLimitError as 'rate_limit'", async () => {
    const err = new FakeRateLimitError("Too many requests");
    const result = await classifyCursorError(err);
    expect(result.reason).toBe("rate_limit");
    expect(result.message).toBe("Too many requests");
  });

  it("classifies AgentBusyError as 'busy'", async () => {
    const err = new FakeAgentBusyError("Agent is busy");
    const result = await classifyCursorError(err);
    expect(result.reason).toBe("busy");
    expect(result.message).toBe("Agent is busy");
  });

  it("classifies NetworkError as 'network'", async () => {
    const err = new FakeNetworkError("Connection refused");
    const result = await classifyCursorError(err);
    expect(result.reason).toBe("network");
    expect(result.message).toBe("Connection refused");
  });

  it("classifies unknown errors as 'error'", async () => {
    const result = await classifyCursorError(new Error("something weird"));
    expect(result.reason).toBe("error");
    expect(result.message).toBe("something weird");
  });

  it("handles non-Error throwables as 'error'", async () => {
    const result = await classifyCursorError("string error");
    expect(result.reason).toBe("error");
    expect(result.message).toBe("string error");
  });

  it("scrubs secrets from error messages", async () => {
    const err = new Error("Auth failed with crsr_abcdef0123456789abcdef012345");
    const result = await classifyCursorError(err);
    expect(result.message).not.toContain("crsr_abcdef0123456789abcdef012345");
    expect(result.message).toContain("[redacted");
  });
});

describe("isAbortError", () => {
  it("returns true for AbortError named errors", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("returns true for 'aborted' message on plain errors", () => {
    expect(isAbortError(new Error("The operation was aborted"))).toBe(true);
  });

  it("returns false for non-abort errors", () => {
    expect(isAbortError(new Error("something else"))).toBe(false);
  });
});
