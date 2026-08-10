import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { videosRoutes } from "../../../src/adapters/openai/videos";
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
  db.prepare(
    "UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1",
  ).run();
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
    scheduler: {
      refreshOnDemand: async () => ({
        bearer: "r",
        expiresAt: 999999,
      }),
    },
    config: { rateLimitCooldownMs: 60_000, modelAliasesRaw: "" },
    log: noopLog,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [],
      chatCompletions: async () => ({
        id: "", object: "chat.completion" as const, created: 0, model: "",
        choices: [], usage: null,
      }),
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({
        created: 1700000000,
        urls: ["https://example.com/video.mp4"],
      }),
      ...overrides?.client,
    },
    retry: withPoolRetry,
  };
}

function createTestApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.use(
    "/v1/*",
    clientAuthGate({
      db: deps.db,
      envKeys: ["test-key"],
      log: deps.log,
    }),
  );
  app.route(
    "/v1",
    videosRoutes({
      pool: deps.pool,
      client: deps.client,
      scheduler: deps.scheduler,
      config: deps.config,
      log: deps.log,
      retry: deps.retry,
    }),
  );
  return app;
}

describe("POST /v1/videos/generations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns 200 with {created, data:[{url}]} on sync generation", async () => {
    let videoGenCalledWith: unknown;
    const client = {
      videoGeneration: async (_bearer: string, body: unknown) => {
        videoGenCalledWith = body;
        return {
          created: 1700000000,
          urls: ["https://example.com/video.mp4"],
        };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "a cat dancing",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1700000000);
    expect(body.data).toEqual([{ url: "https://example.com/video.mp4" }]);

    // videoGeneration called with prompt + no size
    expect(videoGenCalledWith).toEqual({ prompt: "a cat dancing" });
  });

  it("passes size to videoGeneration when provided", async () => {
    let videoGenCalledWith: unknown;
    const client = {
      videoGeneration: async (_bearer: string, body: unknown) => {
        videoGenCalledWith = body;
        return { created: 1, urls: ["https://example.com/v.mp4"] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "a dog", size: "16:9" }),
    });

    expect(res.status).toBe(200);
    expect(videoGenCalledWith).toEqual({ prompt: "a dog", size: "16:9" });
  });

  it("returns 400 when prompt is missing", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 429 on PoolExhaustedError", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use(
      "/v1/*",
      clientAuthGate({ db: deps.db, envKeys: ["test-key"], log: deps.log }),
    );
    app.route(
      "/v1",
      videosRoutes({
        pool,
        client: deps.client,
        scheduler: deps.scheduler,
        config: deps.config,
        log: deps.log,
        retry: deps.retry,
      }),
    );

    const res = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("returns 401 when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /v1/videos/edits", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns 404 (not supported)", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/edits", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        video: "base64data",
        prompt: "edit this",
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 401 when no api key (gate runs first)", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video: "base64", prompt: "edit" }),
    });

    expect(res.status).toBe(401);
  });
});
