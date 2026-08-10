import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { imagesRoutes } from "../../../src/adapters/openai/images";
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

function makeDeps(
  db: Database.Database,
  overrides?: {
    client?: Partial<UpstreamClient>;
  },
) {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
    db,
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000, modelAliasesRaw: "" },
    log: noopLog,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [],
      chatCompletions: async () => ({ id: "", object: "chat.completion" as const, created: 0, model: "", choices: [], usage: null }),
      imageGeneration: async () => ({ created: 1000, urls: ["https://img/gen.png"] }),
      imageEdit: async () => ({ created: 2000, urls: ["https://img/edit.png"] }),
      videoGeneration: async () => ({ created: 0, urls: [] }),
      ...overrides?.client,
    },
    retry: withPoolRetry,
  };
}

function createTestApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.use("/v1/*", clientAuthGate({
    db: deps.db,
    envKeys: ["test-key"],
    log: deps.log,
  }));
  app.route("/v1", imagesRoutes({
    pool: deps.pool,
    client: deps.client,
    scheduler: deps.scheduler,
    config: deps.config,
    log: deps.log,
    retry: deps.retry,
  }));
  return app;
}

describe("POST /v1/images/generations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns {created, data:[{url}]} with correct shape", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "a cat",
        model: "wan2.1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1000);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({ url: "https://img/gen.png" });
  });

  it("n>1 coerced to 1 — returns single url", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "a dog",
        n: 5,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it("passes size to generateImage (core maps to ratio)", async () => {
    let calledWith: unknown;
    const client = {
      imageGeneration: async (_bearer: string, body: unknown) => {
        calledWith = body;
        return { created: 1, urls: ["u"] };
      },
      imageEdit: async () => ({ created: 0, urls: [] }),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "landscape",
        size: "1792x1024",
      }),
    });

    // Core's sizeToRatio maps 1792x1024 → 16:9
    expect(calledWith).toEqual({ prompt: "landscape", size: "16:9" });
  });

  it("returns 429 on PoolExhaustedError", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({
      db: deps.db,
      envKeys: ["test-key"],
      log: deps.log,
    }));
    app.route("/v1", imagesRoutes({
      pool,
      client: deps.client,
      scheduler: deps.scheduler,
      config: deps.config,
      log: deps.log,
      retry: deps.retry,
    }));

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "a cat",
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("returns 401 when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /v1/images/edits", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("passes image + prompt and returns {created, data:[{url}]}", async () => {
    let calledWith: unknown;
    const client = {
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async (_bearer: string, body: unknown) => {
        calledWith = body;
        return { created: 2000, urls: ["https://img/edited.png"] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: "base64data",
        prompt: "add a hat",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2000);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({ url: "https://img/edited.png" });

    expect(calledWith).toEqual({ image: "base64data", prompt: "add a hat" });
  });

  it("returns 429 on PoolExhaustedError for edits", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({
      db: deps.db,
      envKeys: ["test-key"],
      log: deps.log,
    }));
    app.route("/v1", imagesRoutes({
      pool,
      client: deps.client,
      scheduler: deps.scheduler,
      config: deps.config,
      log: deps.log,
      retry: deps.retry,
    }));

    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: "base64",
        prompt: "edit this",
      }),
    });

    expect(res.status).toBe(429);
  });
});
