import { describe, it, expect } from "vitest";
import { createApp } from "../../src/server/app";
import { openDb } from "../../src/store/db";
import { SingleAccountPool } from "../../src/pool/single";
import { RequestThrottle } from "../../src/pool/throttle";
import { TokenMintError } from "../../src/upstream/errors";
import type { AppDeps } from "../../src/server/app";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeStubDeps(): AppDeps {
  const db = openDb(":memory:");
  const pool = new SingleAccountPool({ log: noopLog });
  return {
    db,
    pool,
    client: {} as any,
    scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
    config: {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      emptyCooldownMs: 10_000,
      emptyRetryMax: 3,
      emptyRetryGapMs: 1_000,
      minRequestGapMs: 0,
      maxConcurrency: 1,
      firstPayloadTimeoutMs: 30_000,
      streamIdleTimeoutMs: 30_000,
      apiKeyEnv: ["test-key"],
      modelAliasesRaw: "",
      logLevel: "info",
      proxyCount: 0,
      proxyUrlsRaw: "",
      proxyCountriesRaw: "",
      timeoutMs: 60_000,
      adminKey: undefined,
      baxia: { chromePath: undefined, cacheTtlMs: 1_500_000, baxiaVersion: "2.5.37", preWarm: false, fallback: false, readinessTimeoutMs: 30_000 },
    },
    retry: (async () => { throw new TokenMintError("egress", "mint boom"); }) as any,
    retryStream: (async function* () {}) as any,
    throttle: new RequestThrottle({ minGapMs: 0 }),
    log: noopLog,
  };
}

describe("app.onError — TokenMintError → 503", () => {
  it("OpenAI envelope", async () => {
    const app = createApp(makeStubDeps());
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("mint boom");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("server_error");
  });

  it("Anthropic envelope", async () => {
    const app = createApp(makeStubDeps());
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(JSON.stringify(body)).toContain("mint boom");
  });
});
