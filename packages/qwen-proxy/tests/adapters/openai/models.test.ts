import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { SingleAccountPool } from "../../../src/pool/single";
import { withPoolRetry } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { modelsRoutes } from "../../../src/adapters/openai/models";
import type { UpstreamClient } from "../../../src/upstream/client";
import type { Logger } from "../../../src/server/logger";

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function setupDb(): Database.Database {
  const db = openDb(":memory:");
  return db;
}

interface TestDeps {
  db: Database.Database;
  pool: SingleAccountPool;
  scheduler: { refreshOnDemand: () => Promise<{ bearer: string; expiresAt: number }> };
  config: { emptyCooldownMs: number; emptyRetryMax: number; emptyRetryGapMs: number };
  log: Logger;
  client: UpstreamClient;
  retry: typeof withPoolRetry;
  configModels: { modelAliasesRaw: string };
}

function makeDeps(
  db: Database.Database,
  overrides?: {
    client?: Partial<UpstreamClient>;
    configModels?: { modelAliasesRaw: string };
  },
): TestDeps {
  const pool = new SingleAccountPool({ log: noopLog });
  return {
    db,
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { emptyCooldownMs: 600_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
    log: noopLog,
    client: {
      listModels: async () => [
        { id: "qwen3-max", object: "model" as const, owned_by: "qwen" },
        { id: "wan2.1", object: "model" as const, owned_by: "qwen" },
      ],
      chatCompletions: (async () => ({ id: "", object: "chat.completion" as const, created: 0, model: "", choices: [], usage: null })) as unknown as UpstreamClient["chatCompletions"],
      deleteChats: async () => {},
      ...overrides?.client,
    },
    retry: withPoolRetry,
    configModels: overrides?.configModels ?? { modelAliasesRaw: "" },
  };
}

function createTestApp(deps: TestDeps) {
  const app = new Hono();
  // Auth gate (exempts nothing here — health is mounted separately)
  app.use("/v1/*", clientAuthGate({
    db: deps.db,
    envKeys: ["test-key"],
    log: deps.log,
  }));
  // Models route under /v1
  app.route("/v1", modelsRoutes({
    pool: deps.pool,
    client: deps.client,
    scheduler: deps.scheduler,
    config: deps.config,
    log: deps.log,
    retry: deps.retry,
    configModels: deps.configModels,
  }));
  return app;
}

describe("GET /v1/models", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns live model ids with correct shape", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qwen3-max",
          object: "model",
          owned_by: "qwen",
          created: expect.any(Number),
        }),
        expect.objectContaining({
          id: "wan2.1",
          object: "model",
          owned_by: "qwen",
        }),
      ]),
    );
  });

  it("appends alias ids from config", async () => {
    const deps = makeDeps(db, {
      configModels: {
        modelAliasesRaw: JSON.stringify({ "gpt-4o": "qwen3-max" }),
      },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    const body = await res.json();

    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("qwen3-max");
    expect(ids).toContain("wan2.1");
  });

  it("returns 401 authentication_error when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 429 on PoolExhaustedError with Retry-After header", async () => {
    // Exhaust the pool: mark it rate-limited
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    await pool.markEmptyAndSwitch(0, 60_000);

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({
      db: deps.db,
      envKeys: ["test-key"],
      log: deps.log,
    }));
    app.route("/v1", modelsRoutes({
      pool,
      client: deps.client,
      scheduler: deps.scheduler,
      config: deps.config,
      log: deps.log,
      retry: deps.retry,
      configModels: deps.configModels,
    }));

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("returns empty data when no models and no aliases", async () => {
    const deps = makeDeps(db, {
      client: { listModels: async () => [] } as Partial<UpstreamClient>,
      configModels: { modelAliasesRaw: "" },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});
