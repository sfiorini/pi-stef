/**
 * POST /v1/videos/generations + POST /v1/videos/edits
 *
 * OpenAI-compatible video endpoints.
 *
 * POST /v1/videos/generations → videoGeneration (sync) → 200 {created, data:[{url}]}
 * POST /v1/videos/edits → 404 (not supported)
 *
 * Video is synchronous: the request blocks until the URL is available.
 * No GET /:id endpoint (removed in the qwen.aikit.club repoint).
 */

import type { ImageResult } from "../../upstream/client";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";

export interface VideosRouteDeps extends RetryDeps {
  video: { generateVideo: (params: { prompt: string; size?: string }) => Promise<ImageResult> };
}

export function videosRoutes(deps: VideosRouteDeps) {
  const r = createOpenApiSubApp();

  // ── POST /v1/videos/generations (SYNC) ────────────────────────────────

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
    const size = typeof b.size === "string" ? b.size : undefined;

    try {
      const result = await deps.video.generateVideo({ prompt, ...(size ? { size } : {}) });

      return c.json({
        created: result.created,
        data: result.urls.map((url: string) => ({ url })),
      });
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
