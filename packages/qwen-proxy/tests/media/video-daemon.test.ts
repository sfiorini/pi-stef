import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { withPoolRetry } from "../../src/pool/retry";
import { insertVideoJob, getVideoJob, updateVideoJob } from "../../src/media/video-jobs";
import { VideoPollDaemon } from "../../src/media/video-daemon";
import type { VideoPollDaemonDeps } from "../../src/media/video-daemon";
import { RateLimitError } from "../../src/upstream/errors";
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
  overrides?: Partial<VideoPollDaemonDeps>,
): VideoPollDaemonDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
    db,
    pool,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [],
      createChat: async () => ({ chatId: "" }),
      chatCompletionsStream: async function* () {},
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({ taskId: "", status: "", raw: {} }),
      videoTaskStatus: async () => ({
        taskId: "upstream-1",
        status: "processing",
        raw: {},
      }),
      ...overrides?.client,
    },
    retry: withPoolRetry,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000 },
    log: noopLog,
    now: () => 100_000,
    ...overrides,
  };
}

describe("VideoPollDaemon.tick()", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    db = setupDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls pending jobs and updates processing status", async () => {
    insertVideoJob(db, {
      jobId: "j1",
      accountId: 1,
      upstreamTaskId: "up-1",
      model: "wanx",
      prompt: "test",
    });

    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => ({
          taskId: "up-1",
          status: "processing",
          raw: {},
        }),
      } as unknown as UpstreamClient,
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j1")!;
    expect(job.status).toBe("processing");
    expect(job.attempts).toBe(1);
  });

  it("marks succeeded when upstream status matches success pattern", async () => {
    insertVideoJob(db, {
      jobId: "j2",
      accountId: 1,
      upstreamTaskId: "up-2",
      model: "wanx",
      prompt: "test",
    });

    const rawResult = { task_id: "up-2", task_status: "succeeded", output: "https://cdn/video.mp4" };
    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => ({
          taskId: "up-2",
          status: "succeeded",
          raw: rawResult,
        }),
      } as unknown as UpstreamClient,
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j2")!;
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    expect(JSON.parse(job.result!)).toEqual(rawResult);
  });

  it("marks succeeded for 'completed' status", async () => {
    insertVideoJob(db, {
      jobId: "j3",
      accountId: 1,
      upstreamTaskId: "up-3",
      model: "wanx",
      prompt: "test",
    });

    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => ({
          taskId: "up-3",
          status: "completed",
          raw: { done: true },
        }),
      } as unknown as UpstreamClient,
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j3")!;
    expect(job.status).toBe("succeeded");
  });

  it("marks succeeded for 'success' status (case-insensitive)", async () => {
    insertVideoJob(db, {
      jobId: "j3b",
      accountId: 1,
      upstreamTaskId: "up-3b",
      model: "wanx",
      prompt: "test",
    });

    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => ({
          taskId: "up-3b",
          status: "Success",
          raw: {},
        }),
      } as unknown as UpstreamClient,
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j3b")!;
    expect(job.status).toBe("succeeded");
  });

  it("times out job after 60 attempts", async () => {
    insertVideoJob(db, {
      jobId: "j4",
      accountId: 1,
      upstreamTaskId: "up-4",
      model: "wanx",
      prompt: "test",
    });
    // Set attempts to 60
    updateVideoJob(db, "j4", { attempts: 60, status: "processing" });

    const deps = makeDeps(db);
    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j4")!;
    expect(job.status).toBe("failed");
    expect(job.result).toContain("timeout");
  });

  it("cleans up stale jobs (updated_at < now-24h) at tick start", async () => {
    const now = 1_000_000;
    // Insert job with old updated_at (25h ago)
    insertVideoJob(db, {
      jobId: "j5",
      accountId: 1,
      upstreamTaskId: "up-5",
      model: "wanx",
      prompt: "stale",
      now: now - 25 * 60 * 60 * 1000,
    });
    // Manually set updated_at to old timestamp
    db.prepare("UPDATE video_jobs SET updated_at = ? WHERE job_id = 'j5'").run(
      now - 25 * 60 * 60 * 1000,
    );

    const deps = makeDeps(db, { now: () => now });
    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j5")!;
    expect(job.status).toBe("failed");
    expect(job.result).toContain("stale");
  });

  it("does NOT clean up jobs that are less than 24h old", async () => {
    const now = 1_000_000;
    insertVideoJob(db, {
      jobId: "j6",
      accountId: 1,
      upstreamTaskId: "up-6",
      model: "wanx",
      prompt: "recent",
      now: now - 12 * 60 * 60 * 1000, // 12h ago
    });

    const deps = makeDeps(db, { now: () => now });
    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db, "j6")!;
    // Should still be pending (processing after poll), not failed
    expect(job.status).not.toBe("failed");
  });

  it("leaves job pending on upstream error (log.warn, no status change)", async () => {
    insertVideoJob(db, {
      jobId: "j7",
      accountId: 1,
      upstreamTaskId: "up-7",
      model: "wanx",
      prompt: "test",
    });

    const warnLog = vi.fn();
    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => {
          throw new Error("upstream network error");
        },
      } as unknown as UpstreamClient,
      log: { info: () => {}, warn: warnLog, error: () => {} },
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    // Job should stay queued (never got a status update)
    const job = getVideoJob(db, "j7")!;
    expect(job.status).toBe("queued");
    expect(warnLog).toHaveBeenCalled();
  });

  it("no-op when no pending jobs", async () => {
    const deps = makeDeps(db);
    const daemon = new VideoPollDaemon(deps);
    // Should not throw
    await expect(daemon.tick()).resolves.toBeUndefined();
  });

  it("stale cleanup runs BEFORE polling (so stale jobs are not polled)", async () => {
    const now = 1_000_000;
    insertVideoJob(db, {
      jobId: "j8",
      accountId: 1,
      upstreamTaskId: "up-8",
      model: "wanx",
      prompt: "stale",
      now: now - 25 * 60 * 60 * 1000,
    });
    db.prepare("UPDATE video_jobs SET updated_at = ? WHERE job_id = 'j8'").run(
      now - 25 * 60 * 60 * 1000,
    );

    let videoTaskStatusCalled = false;
    const deps = makeDeps(db, {
      now: () => now,
      client: {
        videoTaskStatus: async () => {
          videoTaskStatusCalled = true;
          return { taskId: "up-8", status: "processing", raw: {} };
        },
      } as unknown as UpstreamClient,
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    // Stale job should be failed, not polled
    const job = getVideoJob(db, "j8")!;
    expect(job.status).toBe("failed");
    expect(videoTaskStatusCalled).toBe(false);
  });

  // ── F2: withPoolRetry failover on RateLimitError ──────────────────────

  it("RateLimitError on the task-creator account leaves the job pending (no failover)", async () => {
    // Set up 2 accounts
    const db2 = openDb(":memory:");
    reconcileAccounts(db2, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db2.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db2, 1, "bearer-1", 999999);
    upsertToken(db2, 2, "bearer-2", 999999);

    insertVideoJob(db2, {
      jobId: "j-failover",
      accountId: 1,
      upstreamTaskId: "up-failover",
      model: "wanx",
      prompt: "test",
    });

    let videoTaskStatusCallCount = 0;
    const client = {
      videoTaskStatus: async (bearer: string) => {
        videoTaskStatusCallCount++;
        if (bearer === "bearer-1") {
          throw new RateLimitError("Rate limited");
        }
        return { taskId: "up-failover", status: "succeeded", raw: { done: true } };
      },
    } as unknown as UpstreamClient;

    const pool = new AccountPool({ db: db2, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps: VideoPollDaemonDeps = {
      db: db2,
      pool,
      client,
      retry: withPoolRetry,
      log: noopLog,
      now: () => 100_000,
      scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
      config: { rateLimitCooldownMs: 60_000 },
    } as unknown as VideoPollDaemonDeps;

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    const job = getVideoJob(db2, "j-failover")!;
    // A5: the poll used the job's account_id (1 = bearer-1) which threw RateLimitError;
    // the daemon warns + leaves the job pending (NO account switch/failover for user-scoped task polls).
    expect(job.status).toBe("queued");
    expect(videoTaskStatusCallCount).toBe(1);
    // pool active is unchanged (no failover)
    expect(pool.getActiveAccount().id).toBe(1);
  });

  // ── A5: poll with task-creator account, not pool-active ──────────────

  it("A5: polls with the job's account_id bearer, not the pool-active", async () => {
    // Set up 2 accounts: account 1 is pool-active, account 2 owns the job
    const db2 = openDb(":memory:");
    reconcileAccounts(db2, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db2.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db2, 1, "bearer-active", 999999);
    upsertToken(db2, 2, "bearer-job-owner", 999999);

    // Job was created by account 2, but pool-active is account 1
    insertVideoJob(db2, {
      jobId: "j-owner",
      accountId: 2,
      upstreamTaskId: "up-owner",
      model: "wanx",
      prompt: "test",
    });

    let calledWithBearer: string | null = null;
    const client = {
      videoTaskStatus: async (bearer: string) => {
        calledWithBearer = bearer;
        return { taskId: "up-owner", status: "succeeded", raw: { done: true } };
      },
    } as unknown as UpstreamClient;

    const pool = new AccountPool({ db: db2, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps: VideoPollDaemonDeps = {
      db: db2,
      pool,
      client,
      retry: withPoolRetry,
      log: noopLog,
      now: () => 100_000,
      scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
      config: { rateLimitCooldownMs: 60_000 },
    } as unknown as VideoPollDaemonDeps;

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    // Must use the JOB account's bearer, not the pool-active
    expect(calledWithBearer).toBe("bearer-job-owner");
    const job = getVideoJob(db2, "j-owner")!;
    expect(job.status).toBe("succeeded");
  });

  it("A5: poll error warns + leaves pending (no withPoolRetry failover)", async () => {
    insertVideoJob(db, {
      jobId: "j-a5-err",
      accountId: 1,
      upstreamTaskId: "up-a5-err",
      model: "wanx",
      prompt: "test",
    });

    const warnLog = vi.fn();
    const deps = makeDeps(db, {
      client: {
        videoTaskStatus: async () => {
          throw new RateLimitError("Rate limited");
        },
      } as unknown as UpstreamClient,
      log: { info: () => {}, warn: warnLog, error: () => {} },
    });

    const daemon = new VideoPollDaemon(deps);
    await daemon.tick();

    // Job should stay queued — error is logged, no failover
    const job = getVideoJob(db, "j-a5-err")!;
    expect(job.status).toBe("queued");
    expect(warnLog).toHaveBeenCalled();
  });
});

describe("VideoPollDaemon.start()/stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() triggers tick at interval", async () => {
    const db = setupDb();
    const deps = makeDeps(db, { intervalMs: 20_000 });
    const daemon = new VideoPollDaemon(deps);

    const tickSpy = vi.fn();
    (daemon as unknown as { tick: () => Promise<void> }).tick = tickSpy;

    daemon.start();
    expect(tickSpy).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    daemon.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tickSpy).toHaveBeenCalledTimes(2); // no more after stop
  });

  it("start() is idempotent — double start doesn't leak interval", async () => {
    const db = setupDb();
    const deps = makeDeps(db, { intervalMs: 20_000 });
    const daemon = new VideoPollDaemon(deps);

    const tickSpy = vi.fn();
    (daemon as unknown as { tick: () => Promise<void> }).tick = tickSpy;

    daemon.start();
    daemon.start(); // second start should be no-op

    await vi.advanceTimersByTimeAsync(20_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    daemon.stop();
  });

  it("stop() is safe if never started", () => {
    const db = setupDb();
    const deps = makeDeps(db);
    const daemon = new VideoPollDaemon(deps);

    expect(() => daemon.stop()).not.toThrow();
  });
});
