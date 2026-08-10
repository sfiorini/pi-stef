import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";
import { reconcileAccounts } from "../src/store/repo";
import { AccountPool } from "../src/pool/state";
import type { AppDeps } from "../src/server/app";

function makeStubDeps(): AppDeps {
  const db = openDb(":memory:");
  reconcileAccounts(db, []);
  const pool = new AccountPool({ db, log: { info: () => {}, warn: () => {}, error: () => {} } });
  pool.hydrate();
  return {
    db,
    pool,
    client: {} as any,
    scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
    config: {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      authUrl: "",
      apiUrl: "",
      jwtRefreshMs: 21600000,
      refreshThresholdMs: 21600000,
      loginTimeoutMs: 10000,
      staggerMs: 5000,
      rateLimitCooldownMs: 86400000,
      reenableIntervalMs: 60000,
      apiKeyEnv: [],
      modelAliasesRaw: "",
      logLevel: "info",
      accounts: [],
      adminKey: undefined,
    },
    retry: (async () => {}) as any,
    retryStream: (async function* () {}) as any,
    media: {
      db,
      pool,
      client: {} as any,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60000 },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      retry: (async () => {}) as any,
      submitVideo: async () => ({ jobId: "" }),
      getVideoJob: () => undefined,
    },
    videoDaemon: { start: () => {}, stop: () => {} } as any,
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
});
