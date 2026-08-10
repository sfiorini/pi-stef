import { describe, it, expect } from "vitest";
import { openaiErrorType, openaiError } from "../../../src/adapters/openai/errors";
import { Hono } from "hono";

describe("openaiErrorType", () => {
  it("maps 400 → invalid_request_error", () => {
    expect(openaiErrorType(400)).toBe("invalid_request_error");
  });

  it("maps 404 → invalid_request_error", () => {
    expect(openaiErrorType(404)).toBe("invalid_request_error");
  });

  it("maps 401 → authentication_error (D11)", () => {
    expect(openaiErrorType(401)).toBe("authentication_error");
  });

  it("maps 403 → permission_error", () => {
    expect(openaiErrorType(403)).toBe("permission_error");
  });

  it("maps 429 → rate_limit_error", () => {
    expect(openaiErrorType(429)).toBe("rate_limit_error");
  });

  it("maps 500 → server_error", () => {
    expect(openaiErrorType(500)).toBe("server_error");
  });

  it("maps 503 → server_error", () => {
    expect(openaiErrorType(503)).toBe("server_error");
  });

  it("maps unknown status → api_error", () => {
    expect(openaiErrorType(418)).toBe("api_error");
    expect(openaiErrorType(200)).toBe("api_error");
  });
});

describe("openaiError", () => {
  it("returns full error envelope with message, type, param, code", async () => {
    const app = new Hono();
    app.get("/test", (c) => openaiError(c, 400, "bad request", { code: "invalid", param: "model" }));

    const res = await app.request("/test");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        message: "bad request",
        type: "invalid_request_error",
        param: "model",
        code: "invalid",
      },
    });
  });

  it("defaults param and code to null when omitted", async () => {
    const app = new Hono();
    app.get("/test", (c) => openaiError(c, 500, "internal error"));

    const res = await app.request("/test");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        message: "internal error",
        type: "server_error",
        param: null,
        code: null,
      },
    });
  });

  it("429 rate_limit_error shape", async () => {
    const app = new Hono();
    app.get("/test", (c) => openaiError(c, 429, "rate limit exceeded", { code: "rate_limit_exceeded" }));

    const res = await app.request("/test");
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });
});
