import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";
import { SingleAccountPool } from "../src/pool/single";
import { RequestThrottle } from "../src/pool/throttle";
import type { AppDeps } from "../src/server/app";

function makeStubDeps(): AppDeps {
  const db = openDb(":memory:");
  const pool = new SingleAccountPool({ log: { info: () => {}, warn: () => {}, error: () => {} } });
  return {
    db,
    pool,
    client: {} as any,
    scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
    config: {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      rateLimitCooldownMs: 86400000,
      emptyCooldownMs: 10_000,
      emptyRetryMax: 3,
      emptyRetryGapMs: 1_000,
      minRequestGapMs: 0,
      maxConcurrency: 1,
      apiKeyEnv: ["test-key"],
      modelAliasesRaw: "",
      logLevel: "info",
      adminKey: undefined,
      baxia: { useChromeBaxia: false, chromePath: undefined, cacheTtlMs: 1_500_000, baxiaVersion: "2.5.37", preWarm: false, fallback: false },
    },
    retry: (async () => {}) as any,
    retryStream: (async function* () {}) as any,
    throttle: new RequestThrottle({ minGapMs: 0 }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("health", () => {
  it("GET /v1/health returns 200 with {status:'ok'}", async () => {
    const app = createApp(makeStubDeps());
    const res = await app.request("/v1/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("POST /v1/images/generations returns 404 (route removed)", async () => {
    const app = createApp(makeStubDeps());
    // Satisfy the auth gate (apiKeyEnv includes "test-key"), then the removed route 404s
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });

    expect(res.status).toBe(404);
  });
});
