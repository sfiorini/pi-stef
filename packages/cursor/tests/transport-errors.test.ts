import { describe, expect, it } from "vitest";

import { attachClassification, classifyTransportError } from "../src/transport-errors";

describe("classifyTransportError maps status/code/message to kinds", () => {
  const kind = classifyTransportError;

  it("classifies auth via 401/403 and token-expired messages", () => {
    expect(kind({ httpStatus: 401 }).kind).toBe("auth");
    expect(kind({ httpStatus: 403 }).kind).toBe("auth");
    expect(kind({ error: new Error("token expired") }).kind).toBe("auth");
    expect(kind({ error: new Error("unauthorized access") }).kind).toBe("auth");
    expect(kind({ error: new Error("Request forbidden by policy") }).kind).toBe("auth");
  });

  it("classifies transient via 429 / 5xx", () => {
    expect(kind({ httpStatus: 429 }).kind).toBe("transient");
    expect(kind({ httpStatus: 500 }).kind).toBe("transient");
    expect(kind({ httpStatus: 503 }).kind).toBe("transient");
  });

  it("classifies transient via Connect codes", () => {
    expect(kind({ connectCode: "unavailable" }).kind).toBe("transient");
    expect(kind({ connectCode: "resource_exhausted" }).kind).toBe("transient");
    expect(kind({ connectCode: "deadline_exceeded" }).kind).toBe("transient");
    expect(kind({ connectCode: "canceled" }).kind).toBe("transient");
  });

  it("classifies transient via Node socket error messages", () => {
    expect(kind({ error: new Error("write ECONNRESET") }).kind).toBe("transient");
    expect(kind({ error: new Error("socket hang up") }).kind).toBe("transient");
    expect(kind({ error: new Error("Error: RST_STREAM") }).kind).toBe("transient");
  });

  it("classifies everything else as fatal (default-deny)", () => {
    expect(kind({ httpStatus: 404 }).kind).toBe("fatal");
    expect(kind({ httpStatus: 400 }).kind).toBe("fatal");
    expect(kind({ connectCode: "invalid_argument" }).kind).toBe("fatal");
    expect(kind({ error: new Error("something weird") }).kind).toBe("fatal");
    expect(kind({}).kind).toBe("fatal");
  });

  it("exposes a retryable flag consistent with the kind", () => {
    expect(kind({ httpStatus: 429 }).retryable).toBe(true);
    expect(kind({ httpStatus: 401 }).retryable).toBe(true);
    expect(kind({ httpStatus: 404 }).retryable).toBe(false);
    expect(kind({}).retryable).toBe(false);
  });

  it("attachClassification stamps kind/retryable onto an Error", () => {
    const err = attachClassification(new Error("boom"), kind({ httpStatus: 429 }));
    expect(err.kind).toBe("transient");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("boom");
  });
});
