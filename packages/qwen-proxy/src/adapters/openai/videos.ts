/**
 * POST /v1/videos/generations + GET /v1/videos/generations/:id + POST /v1/videos/edits
 *
 * OpenAI-compatible video endpoints.
 *
 * POST /v1/videos/generations → submitVideo → 202 {id, status:"queued"}
 * GET  /v1/videos/generations/:id → getVideoJob → {id, status, progress?, result?}
 * POST /v1/videos/edits → 404 (PISTQWE-7 AC5 — not supported)
 */

import type { UpstreamClient } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import type { VideoJobRow } from "../../media/video-jobs";
import { PoolExhaustedError } from "../../pool/errors";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";

export interface VideosRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "videoGeneration">;
  retry: typeof WithPoolRetryFn;
  submitVideo: (params: {
    prompt: string;
    image?: string;
    model?: string;
  }) => Promise<{ jobId: string }>;
  getVideoJob: (jobId: string) => VideoJobRow | undefined;
}

export function videosRoutes(deps: VideosRouteDeps) {
  const r = createOpenApiSubApp();

  // ── POST /v1/videos/generations ─────────────────────────────────────────

  r.post("/videos/generations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(c, 400, "Invalid JSON body", { code: "bad_request" });
    }

    const b = body as Record<string, unknown>;

    if (!b.prompt || typeof b.prompt !== "string") {
      return openaiError(c, 400, "prompt is required", {
        code: "invalid_request_error",
        param: "prompt",
      });
    }

    const prompt = b.prompt as string;
    const image = typeof b.image === "string" ? b.image : undefined;
    const model = typeof b.model === "string" ? b.model : undefined;

    try {
      const result = await deps.submitVideo({ prompt, image, model });
      return c.json({ id: result.jobId, status: "queued" }, 202);
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return poolExhaustedResponse(c, err);
      }
      throw err;
    }
  });

  // ── POST /v1/videos/edits → 404 (PISTQWE-7 AC5) ──────────────────────

  r.post("/videos/edits", (c) => {
    return openaiError(c, 404, "Video edits are not supported", {
      code: "invalid_request_error",
    });
  });

  // ── GET /v1/videos/generations/:id ─────────────────────────────────────

  r.get("/videos/generations/:id", (c) => {
    const id = c.req.param("id");
    const job = deps.getVideoJob(id);

    if (!job) {
      return openaiError(c, 404, `Video job '${id}' not found`, {
        code: "invalid_request_error",
      });
    }

    // Build response based on status
    const response: Record<string, unknown> = {
      id: job.job_id,
      status: job.status,
    };

    // Add progress for processing jobs
    if (job.status === "processing") {
      response.progress = job.progress;
    }

    // Add result for succeeded/failed jobs
    if (job.result !== null && job.result !== undefined) {
      try {
        response.result = JSON.parse(job.result);
      } catch {
        // If result isn't valid JSON, pass as-is
        response.result = job.result;
      }
    }

    return c.json(response, 200);
  });

  return r;
}

function poolExhaustedResponse(c: any, err: PoolExhaustedError) {
  const retryAfterMs = err.earliestReEnableAt
    ? Math.max(0, err.earliestReEnableAt - Date.now())
    : 60_000;
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  c.header("Retry-After", String(retryAfterSec));
  return c.json(
    {
      error: {
        message: "All accounts rate-limited",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    },
    429,
  );
}
