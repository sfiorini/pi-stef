import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { withPoolRetry } from "../../src/pool/retry";
import { submitVideo, getVideoJob } from "../../src/media/videos";
import type { MediaVideoDeps } from "../../src/media/videos";
import type { UpstreamClient } from "../../src/upstream/client";
import type { Account } from "../../src/config/types";
import type { Logger } from "../../src/server/logger";

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
  clientOverrides?: Partial<UpstreamClient>,
): MediaVideoDeps {
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
      listModels: async () => [],
      createChat: async () => ({ chatId: "" }),
      chatCompletionsStream: async function* () {},
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({
        taskId: "upstream-task-123",
        status: "submitted",
        raw: {},
      }),
      videoTaskStatus: async () => ({
        taskId: "upstream-task-123",
        status: "processing",
        raw: {},
      }),
      ...clientOverrides,
    },
    retry: withPoolRetry,
  };
}

describe("submitVideo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("submits video and returns a uuid jobId", async () => {
    const deps = makeDeps(db);
    const result = await submitVideo(deps, { prompt: "a dancing cat" });

    expect(result.jobId).toBeDefined();
    expect(result.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("inserts a row with upstream task id", async () => {
    const deps = makeDeps(db);
    const result = await submitVideo(deps, { prompt: "test prompt" });

    const job = getVideoJob(db, result.jobId);
    expect(job).toBeDefined();
    expect(job!.upstream_task_id).toBe("upstream-task-123");
    expect(job!.account_id).toBe(1);
    expect(job!.prompt).toBe("test prompt");
    expect(job!.status).toBe("queued");
  });

  it("stores model when provided", async () => {
    const deps = makeDeps(db);
    const result = await submitVideo(deps, { prompt: "test", model: "wan2.1" });

    const job = getVideoJob(db, result.jobId);
    expect(job!.model).toBe("wan2.1");
  });

  it("stores null model when not provided", async () => {
    const deps = makeDeps(db);
    const result = await submitVideo(deps, { prompt: "test" });

    const job = getVideoJob(db, result.jobId);
    expect(job!.model).toBeNull();
  });

  it("upstream task id is stored, proxy job id is returned (distinct)", async () => {
    const deps = makeDeps(db, {
      videoGeneration: async () => ({
        taskId: "real-upstream-id-999",
        status: "submitted",
        raw: { task_id: "real-upstream-id-999" },
      }),
    });
    const result = await submitVideo(deps, { prompt: "test" });

    // The returned id is a uuid, NOT the upstream task id
    expect(result.jobId).not.toBe("real-upstream-id-999");
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const job = getVideoJob(db, result.jobId);
    expect(job!.upstream_task_id).toBe("real-upstream-id-999");
  });
});

describe("getVideoJob", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns the video job after submit", async () => {
    const deps = makeDeps(db);
    const result = await submitVideo(deps, { prompt: "test" });

    const job = getVideoJob(db, result.jobId);
    expect(job).toBeDefined();
    expect(job!.job_id).toBe(result.jobId);
    expect(job!.status).toBe("queued");
  });

  it("returns undefined for unknown jobId", () => {
    expect(getVideoJob(db, "nonexistent")).toBeUndefined();
  });
});
