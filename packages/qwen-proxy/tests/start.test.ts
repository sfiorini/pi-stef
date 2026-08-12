import { describe, it, expect } from "vitest";
import { startServer } from "../src/server/start";
import type { AppDeps } from "../src/server/app";
import { openDb } from "../src/store/db";
import { SingleAccountPool } from "../src/pool/single";
import { RequestThrottle } from "../src/pool/throttle";

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
      rateLimitCooldownMs: 86400000,
      emptyCooldownMs: 10_000,
      emptyRetryMax: 3,
      emptyRetryGapMs: 1_000,
      minRequestGapMs: 0,
      maxConcurrency: 1,
      apiKeyEnv: [],
      modelAliasesRaw: "",
      logLevel: "info",
      adminKey: undefined,
      baxia: { useChromeBaxia: false, chromePath: undefined, cacheTtlMs: 1_500_000, baxiaVersion: "2.5.37", preWarm: false, fallback: false },
    },
    retry: (async () => {}) as any,
    retryStream: (async function* () {}) as any,
    throttle: new RequestThrottle({ minGapMs: 0 }),
    log: noopLog,
  };
}

describe("startServer", () => {
  it("starts and stops on a random port", async () => {
    const deps = makeStubDeps();
    const handle = await startServer({ ...deps, port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    handle.close();
  });

  it("rejects with clear error on EADDRINUSE", async () => {
    const deps1 = makeStubDeps();
    const handle1 = await startServer({ ...deps1, port: 0 });

    // Try to start second server on same port
    const deps2 = makeStubDeps();
    await expect(startServer({ ...deps2, port: handle1.port }))
      .rejects.toThrow(/already in use|EADDRINUSE/i);

    handle1.close();
  });
});
