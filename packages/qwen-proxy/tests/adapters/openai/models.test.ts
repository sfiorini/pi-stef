import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { modelsRoutes } from "../../../src/adapters/openai/models";
import type { UpstreamClient } from "../../../src/upstream/client";
import type { Account } from "../../../src/config/types";
import type { Logger } from "../../../src/server/logger";

const ACCOUNTS: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
];

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function setupDb(): Database.Database {
  const db = openDb(":memory:");
  reconcileAccounts(db, ACCOUNTS);
  db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
  upsertToken(db, 1, "test-bearer", 999999);
  return db;
}

interface TestDeps {
  db: Database.Database;
  pool: AccountPool;
  scheduler: { refreshOnDemand: () => Promise<{ bearer: string; expiresAt: number }> };
  config: { rateLimitCooldownMs: number };
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
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
    db,
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000 },
    log: noopLog,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [
        { id: "qwen3-max", object: "model" as const, owned_by: "qwen" },
        { id: "wan2.1", object: "model" as const, owned_by: "qwen" },
      ],
      createChat: async () => ({ chatId: "" }),
      chatCompletionsStream: async function* () {},
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({ taskId: "", status: "", raw: {} }),
      videoTaskStatus: async () => ({ taskId: "", status: "", raw: {} }),
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
    // Exhaust the pool: disable the only account
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    // Override pool to be exhausted
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
