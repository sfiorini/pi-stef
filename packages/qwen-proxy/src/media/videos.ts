import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { UpstreamClient } from "../upstream/client";
import type { RetryDeps } from "../pool/retry";
import type { withPoolRetry as WithPoolRetry } from "../pool/retry";
import { insertVideoJob, getVideoJob as repoGetVideoJob, type VideoJobRow } from "./video-jobs";

export { getVideoJob as repoGetVideoJob } from "./video-jobs";

export interface MediaVideoDeps extends RetryDeps {
  db: Database.Database;
  client: Pick<UpstreamClient, "videoGeneration">;
  retry: typeof WithPoolRetry;
}

export interface SubmitVideoParams {
  prompt: string;
  image?: string;
  model?: string;
}

export interface SubmitVideoResult {
  jobId: string;
}

/**
 * Submit a video generation task.
 * 1. Get active account from pool.
 * 2. Call upstream videoGeneration via withPoolRetry.
 * 3. Generate proxy jobId (randomUUID), store mapping.
 * 4. Return proxy jobId (NOT the upstream task id).
 */
export async function submitVideo(
  deps: MediaVideoDeps,
  params: SubmitVideoParams,
): Promise<SubmitVideoResult> {
  const upstreamResult = await deps.retry(deps, async (_accountId, bearer) => {
    return deps.client.videoGeneration(bearer, {
      prompt: params.prompt,
      image: params.image,
    });
  });

  // Get the account that was used (pool gives us the active one after retry)
  const activeAccount = deps.pool.getActiveAccount();
  const jobId = randomUUID();

  insertVideoJob(deps.db, {
    jobId,
    accountId: activeAccount.id,
    upstreamTaskId: upstreamResult.taskId,
    model: params.model ?? null,
    prompt: params.prompt,
  });

  return { jobId };
}

/**
 * Get a video job by proxy job id.
 * Returns the DB row directly (non-blocking read).
 */
export function getVideoJob(
  db: Database.Database,
  jobId: string,
): VideoJobRow | undefined {
  return repoGetVideoJob(db, jobId);
}
