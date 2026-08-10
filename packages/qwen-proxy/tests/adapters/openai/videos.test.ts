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

interface VideoJobRow {
  job_id: string;
  account_id: number | null;
  upstream_task_id: string;
  model: string | null;
  prompt: string;
  status: string;
  progress: number;
  result: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

function makeDeps(
  db: Database.Database,
  overrides?: {
    client?: Partial<UpstreamClient>;
    submitVideo?: () => Promise<{ jobId: string }>;
    getVideoJob?: (jobId: string) => VideoJobRow | undefined;
  },
) {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();

  const defaultSubmit = async () => {
    // Insert a real row
    const jobId = "test-job-uuid-123";
    const now = Date.now();
    db.prepare(
      `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
       VALUES (?, 1, 'upstream-task-1', 'wan2.1', 'test prompt', 'queued', 0, NULL, 0, ?, ?)`,
    ).run(jobId, now, now);
    return { jobId };
  };

  const defaultGetVideoJob = (jobId: string) => {
    return db
      .prepare("SELECT * FROM video_jobs WHERE job_id = ?")
      .get(jobId) as VideoJobRow | undefined;
  };

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
      createChat: async () => ({ chatId: "" }),
      chatCompletionsStream: async function* () {},
      imageGeneration: async () => ({
        created: 1000,
        urls: ["https://img/gen.png"],
      }),
      imageEdit: async () => ({
        created: 2000,
        urls: ["https://img/edit.png"],
      }),
      videoGeneration: async () => ({
        taskId: "upstream-task-1",
        status: "submitted",
        raw: {},
      }),
      videoTaskStatus: async () => ({
        taskId: "",
        status: "",
        raw: {},
      }),
      ...overrides?.client,
    },
    retry: withPoolRetry,
    submitVideo: overrides?.submitVideo ?? defaultSubmit,
    getVideoJob: overrides?.getVideoJob ?? defaultGetVideoJob,
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
      submitVideo: deps.submitVideo,
      getVideoJob: deps.getVideoJob,
    }),
  );
  return app;
}

describe("POST /v1/videos/generations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns 202 with {id, status:'queued'} on submit", async () => {
    const deps = makeDeps(db);
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

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe("test-job-uuid-123");
    expect(body.status).toBe("queued");
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

describe("GET /v1/videos/generations/:id", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns queued status for a queued job", async () => {
    // Insert a queued job
    const now = Date.now();
    db.prepare(
      `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
       VALUES ('job-1', 1, 'upstream-1', 'wan2.1', 'prompt', 'queued', 0, NULL, 0, ?, ?)`,
    ).run(now, now);

    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/job-1", {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("job-1");
    expect(body.status).toBe("queued");
    expect(body.progress).toBeUndefined();
    expect(body.result).toBeUndefined();
  });

  it("returns processing status with progress", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
       VALUES ('job-2', 1, 'upstream-2', 'wan2.1', 'prompt', 'processing', 30, NULL, 5, ?, ?)`,
    ).run(now, now);

    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/job-2", {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("job-2");
    expect(body.status).toBe("processing");
    expect(body.progress).toBe(30);
  });

  it("returns succeeded status with result", async () => {
    const now = Date.now();
    const result = JSON.stringify({
      url: "https://example.com/video.mp4",
      duration: 10,
    });
    db.prepare(
      `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
       VALUES ('job-3', 1, 'upstream-3', 'wan2.1', 'prompt', 'succeeded', 100, ?, 10, ?, ?)`,
    ).run(result, now, now);

    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/job-3", {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("job-3");
    expect(body.status).toBe("succeeded");
    expect(body.result).toEqual({
      url: "https://example.com/video.mp4",
      duration: 10,
    });
  });

  it("returns failed status with error info", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
       VALUES ('job-4', 1, 'upstream-4', 'wan2.1', 'prompt', 'failed', 0, ?, 60, ?, ?)`,
    ).run(JSON.stringify({ error: "timeout" }), now, now);

    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/job-4", {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("job-4");
    expect(body.status).toBe("failed");
    expect(body.result).toEqual({ error: "timeout" });
  });

  it("returns 404 for unknown job id", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/nonexistent-id", {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/not found/i);
  });

  it("returns 401 when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/videos/generations/job-1");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/videos/edits", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns 404 (not supported, PISTQWE-7 AC5)", async () => {
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
