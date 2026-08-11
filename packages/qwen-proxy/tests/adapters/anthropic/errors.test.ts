import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  anthropicErrorType,
  anthropicError,
} from "../../../src/adapters/anthropic/errors";

describe("anthropicErrorType", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [529, "overloaded_error"],
    [503, "api_error"],
    [418, "api_error"],
  ])("status %d → %s", (status, expected) => {
    expect(anthropicErrorType(status)).toBe(expected);
  });
});

describe("anthropicError", () => {
  it("returns {type:'error', error:{type, message}} envelope", async () => {
    const app = new Hono();
    app.get("/test", (c) => anthropicError(c, 400, "invalid_request_error", "bad request"));

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "bad request",
      },
    });
  });

  it("defaults type to anthropicErrorType(status)", async () => {
    const app = new Hono();
    app.get("/test", (c) => anthropicError(c, 429));

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "An error occurred",
      },
    });
  });

  it("uses custom type override", async () => {
    const app = new Hono();
    app.get("/test", (c) => anthropicError(c, 401, "authentication_error", "Invalid API key"));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid API key",
      },
    });
  });
});
