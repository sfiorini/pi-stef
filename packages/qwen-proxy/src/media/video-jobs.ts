import type Database from "better-sqlite3";

export interface VideoJobRow {
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

export function insertVideoJob(
  db: Database.Database,
  params: {
    jobId: string;
    accountId: number | null;
    upstreamTaskId: string;
    model?: string | null;
    prompt: string;
    now?: number;
  },
): void {
  const now = params.now ?? Date.now();
  db.prepare(
    `INSERT INTO video_jobs (job_id, account_id, upstream_task_id, model, prompt, status, progress, result, attempts, created_at, updated_at)
     VALUES (@jobId, @accountId, @upstreamTaskId, @model, @prompt, 'queued', 0, NULL, 0, @now, @now)`,
  ).run({
    jobId: params.jobId,
    accountId: params.accountId,
    upstreamTaskId: params.upstreamTaskId,
    model: params.model ?? null,
    prompt: params.prompt,
    now,
  });
}

export function getVideoJob(
  db: Database.Database,
  jobId: string,
): VideoJobRow | undefined {
  return db
    .prepare("SELECT * FROM video_jobs WHERE job_id = ?")
    .get(jobId) as VideoJobRow | undefined;
}

export function updateVideoJob(
  db: Database.Database,
  jobId: string,
  fields: Partial<{
    status: string;
    progress: number;
    attempts: number;
    result: string;
    account_id: number | null;
  }>,
): void {
  const sets: string[] = ["updated_at = @updatedAt"];
  const params: Record<string, unknown> = { jobId, updatedAt: Date.now() };

  if (fields.status !== undefined) {
    sets.push("status = @status");
    params.status = fields.status;
  }
  if (fields.progress !== undefined) {
    sets.push("progress = @progress");
    params.progress = fields.progress;
  }
  if (fields.attempts !== undefined) {
    sets.push("attempts = @attempts");
    params.attempts = fields.attempts;
  }
  if (fields.result !== undefined) {
    sets.push("result = @result");
    params.result = fields.result;
  }
  if (fields.account_id !== undefined) {
    sets.push("account_id = @accountId");
    params.accountId = fields.account_id;
  }

  db.prepare(`UPDATE video_jobs SET ${sets.join(", ")} WHERE job_id = @jobId`).run(params);
}

export function listPendingVideoJobs(db: Database.Database): VideoJobRow[] {
  return db
    .prepare(
      `SELECT * FROM video_jobs
       WHERE status IN ('queued', 'processing')
       ORDER BY created_at ASC`,
    )
    .all() as VideoJobRow[];
}

export function markVideoJobFailed(
  db: Database.Database,
  jobId: string,
  reason: string,
): void {
  db.prepare(
    `UPDATE video_jobs
     SET status = 'failed', result = @result, updated_at = @updatedAt
     WHERE job_id = @jobId AND status != 'failed'`,
  ).run({
    jobId,
    result: JSON.stringify({ error: reason }),
    updatedAt: Date.now(),
  });
}
