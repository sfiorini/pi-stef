/**
 * Background daemon that polls upstream for video task status.
 *
 * On each tick:
 *   0. Mark stale jobs (updated_at < now-24h, status queued/processing) as failed.
 *   1. For each remaining pending job:
 *      - attempts >= 60 → mark failed (timeout)
 *      - else → poll upstream; succeeded → update; else → bump attempts
 *
 * Mirrors ReenableDaemon's idempotent start()/stop() pattern.
 */

import type Database from "better-sqlite3";
import type { UpstreamClient } from "../upstream/client";
import type { Logger } from "../server/logger";
import type { withPoolRetry as WithPoolRetryFn, RetryDeps } from "../pool/retry";
import {
  listPendingVideoJobs,
  updateVideoJob,
  markVideoJobFailed,
} from "./video-jobs";

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS = 60;
const DEFAULT_INTERVAL_MS = 20_000;

// Extends RetryDeps so `this.deps` is assignable to RetryDeps for the withPoolRetry
// call (pool/scheduler/config/log are required, matching chat.ts / videos.ts).
export interface VideoPollDaemonDeps extends RetryDeps {
  db: Database.Database;
  client: UpstreamClient;
  retry: typeof WithPoolRetryFn;
  intervalMs?: number;
  now?: () => number;
}

export class VideoPollDaemon {
  private db: Database.Database;
  private client: UpstreamClient;
  private deps: VideoPollDaemonDeps;
  private log: Logger;
  private intervalMs: number;
  private now: () => number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: VideoPollDaemonDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.deps = deps;
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Run one poll cycle.
   * 0. Mark stale jobs as failed.
   * 1. Poll each remaining pending job.
   */
  async tick(): Promise<void> {
    const now = this.now();

    // Step 0: mark stale jobs (updated_at < now-24h AND status IN queued/processing)
    const staleThreshold = now - STALE_MS;
    const staleJobs = this.db
      .prepare(
        `SELECT job_id FROM video_jobs
         WHERE status IN ('queued', 'processing') AND updated_at < ?`,
      )
      .all(staleThreshold) as { job_id: string }[];
    for (const row of staleJobs) {
      markVideoJobFailed(this.db, row.job_id, "stale");
    }

    // Step 1: poll remaining pending jobs
    const pending = listPendingVideoJobs(this.db);
    for (const job of pending) {
      // Timeout guard: >= 60 attempts → failed
      if (job.attempts >= MAX_ATTEMPTS) {
        markVideoJobFailed(this.db, job.job_id, "timeout");
        continue;
      }

      try {
        // F2: Use withPoolRetry for failover on RateLimitError
        const result = await this.deps.retry(this.deps, async (_id, bearer) => {
          return this.client.videoTaskStatus(
            bearer,
            job.upstream_task_id!,
          );
        });

        if (/success|succeeded|completed/i.test(result.status)) {
          updateVideoJob(this.db, job.job_id, {
            status: "succeeded",
            progress: 100,
            result: JSON.stringify(result.raw),
          });
        } else {
          updateVideoJob(this.db, job.job_id, {
            status: "processing",
            progress: job.attempts + 1,
            attempts: job.attempts + 1,
          });
        }
      } catch (err) {
        this.log.warn("video daemon poll error", {
          jobId: job.job_id,
          upstreamTaskId: job.upstream_task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Start the periodic poll interval. Idempotent — double start is a no-op. */
  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  /** Stop the periodic poll. Safe if never started. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
