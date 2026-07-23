import { afterEach, describe, expect, it } from "vitest";

import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
  resolveCursorRequestHeaders,
} from "../src/cursor-request-headers";

const baseOptions = {
  accessToken: "tok_abc",
  rpcPath: "/agent.v1.AgentService/Run",
};

describe("resolveCursorRequestHeaders", () => {
  afterEach(() => {
    delete process.env.PI_CURSOR_CLIENT_VERSION;
  });

  it("sets Connect streaming content-type and bearer auth", () => {
    const headers = resolveCursorRequestHeaders(baseOptions);

    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers.te).toBe("trailers");
    expect(headers.authorization).toBe("Bearer tok_abc");
    expect(headers["x-ghost-mode"]).toBe("true");
    expect(headers["x-cursor-client-version"]).toBe(CURSOR_CLIENT_VERSION);
    expect(headers["x-cursor-client-type"]).toBe(CURSOR_CLIENT_TYPE);
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("flips to application/proto for unary requests", () => {
    expect(resolveCursorRequestHeaders({ ...baseOptions, unary: false })["content-type"]).toBe(
      "application/connect+proto",
    );
    expect(resolveCursorRequestHeaders({ ...baseOptions, unary: true })["content-type"]).toBe(
      "application/proto",
    );
  });

  it("exposes the documented default cursor client version", () => {
    // Captured at module load; equals the documented fallback when the env var is unset.
    expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.05.01-eea359f");
    expect(CURSOR_CLIENT_TYPE).toBe("cli");
  });
});
