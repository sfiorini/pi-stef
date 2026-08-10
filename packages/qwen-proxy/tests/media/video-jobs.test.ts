import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import {
  insertVideoJob,
  getVideoJob,
  updateVideoJob,
  listPendingVideoJobs,
  markVideoJobFailed,
} from "../../src/media/video-jobs";

function setupDb(): Database.Database {
  const db = openDb(":memory:");
  // Ensure a dummy account for FK (ON DELETE SET NULL — but we need one to reference)
  db.prepare(
    "INSERT INTO accounts (id, email, password, ord, state) VALUES (1, 'a@test.com', 'pw', 1, 'active')",
  ).run();
  return db;
}

describe("video-jobs repo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("insertVideoJob + getVideoJob round-trip", () => {
    const jobId = "job-001";
    const now = Date.now();
    insertVideoJob(db, {
      jobId,
      accountId: 1,
      upstreamTaskId: "upstream-abc",
      model: "wanx",
      prompt: "a dancing cat",
      now,
    });

    const job = getVideoJob(db, jobId);
    expect(job).toBeDefined();
    expect(job!.job_id).toBe(jobId);
    expect(job!.account_id).toBe(1);
    expect(job!.upstream_task_id).toBe("upstream-abc");
    expect(job!.model).toBe("wanx");
    expect(job!.prompt).toBe("a dancing cat");
    expect(job!.status).toBe("queued");
    expect(job!.progress).toBe(0);
    expect(job!.attempts).toBe(0);
    expect(job!.created_at).toBe(now);
    expect(job!.updated_at).toBe(now);
  });

  it("getVideoJob returns undefined for unknown id", () => {
    expect(getVideoJob(db, "nonexistent")).toBeUndefined();
  });

  it("updateVideoJob updates fields", () => {
    insertVideoJob(db, {
      jobId: "job-002",
      accountId: 1,
      upstreamTaskId: "up-2",
      model: "wanx",
      prompt: "test",
    });

    updateVideoJob(db, "job-002", {
      status: "processing",
      progress: 5,
      attempts: 3,
    });

    const job = getVideoJob(db, "job-002")!;
    expect(job.status).toBe("processing");
    expect(job.progress).toBe(5);
    expect(job.attempts).toBe(3);
  });

  it("listPendingVideoJobs returns queued and processing jobs ordered by created_at", () => {
    const now = 1000;
    insertVideoJob(db, { jobId: "j1", accountId: 1, upstreamTaskId: "u1", model: "m", prompt: "p1", now });
    insertVideoJob(db, { jobId: "j2", accountId: 1, upstreamTaskId: "u2", model: "m", prompt: "p2", now: now + 10 });
    insertVideoJob(db, { jobId: "j3", accountId: 1, upstreamTaskId: "u3", model: "m", prompt: "p3", now: now + 20 });

    // Mark one as succeeded
    updateVideoJob(db, "j2", { status: "succeeded" });

    const pending = listPendingVideoJobs(db);
    expect(pending).toHaveLength(2);
    expect(pending[0].job_id).toBe("j1");
    expect(pending[1].job_id).toBe("j3");
    // Ordered by created_at ASC
    expect(pending[0].created_at).toBeLessThan(pending[1].created_at);
  });

  it("listPendingVideoJobs returns empty when none pending", () => {
    expect(listPendingVideoJobs(db)).toEqual([]);
  });

  it("markVideoJobFailed sets status to failed with reason in result", () => {
    insertVideoJob(db, {
      jobId: "job-fail",
      accountId: 1,
      upstreamTaskId: "u-fail",
      model: "m",
      prompt: "p",
    });

    markVideoJobFailed(db, "job-fail", "timeout");

    const job = getVideoJob(db, "job-fail")!;
    expect(job.status).toBe("failed");
    expect(job.result).toContain("timeout");
  });

  it("markVideoJobFailed is idempotent for already-failed jobs", () => {
    insertVideoJob(db, {
      jobId: "job-fail2",
      accountId: 1,
      upstreamTaskId: "u",
      model: "m",
      prompt: "p",
    });

    markVideoJobFailed(db, "job-fail2", "stale");
    markVideoJobFailed(db, "job-fail2", "timeout"); // should not throw

    const job = getVideoJob(db, "job-fail2")!;
    expect(job.status).toBe("failed");
  });

  it("insertVideoJob with null accountId (ON DELETE SET NULL scenario)", () => {
    insertVideoJob(db, {
      jobId: "job-null-acct",
      accountId: null,
      upstreamTaskId: "u-null",
      model: "m",
      prompt: "p",
    });

    const job = getVideoJob(db, "job-null-acct")!;
    expect(job.account_id).toBeNull();
  });

  it("listPendingVideoJobs does not return failed jobs", () => {
    insertVideoJob(db, { jobId: "j4", accountId: 1, upstreamTaskId: "u4", model: "m", prompt: "p4" });
    markVideoJobFailed(db, "j4", "timeout");

    expect(listPendingVideoJobs(db)).toHaveLength(0);
  });
});
