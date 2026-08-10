/**
 * POST /v1/images/generations + POST /v1/images/edits
 * OpenAI-compatible image endpoints.
 *
 * Delegates to media/images.ts core (D9 — one registration per endpoint).
 * Pool exhausted → 429 rate_limit_error.
 */

import type { UpstreamClient } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { generateImage, editImage } from "../../media/images";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";

export interface ImagesRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "imageGeneration" | "imageEdit">;
  retry: typeof WithPoolRetryFn;
}

export function imagesRoutes(deps: ImagesRouteDeps) {
  const r = createOpenApiSubApp();

  // ── POST /v1/images/generations ─────────────────────────────────────────

  r.post("/images/generations", async (c) => {
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
    // n>1 coerced to 1 at adapter layer (D9)
    const n = typeof b.n === "number" && b.n > 1 ? 1 : 1;

    try {
      const result = await generateImage(deps, { prompt, size, n });

      const created = result.created;
      const data = result.urls.map((url) => ({ url }));

      return c.json({ created, data });
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return poolExhaustedResponse(c, err);
      }
      throw err;
    }
  });

  // ── POST /v1/images/edits ───────────────────────────────────────────────

  r.post("/images/edits", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(c, 400, "Invalid JSON body", { code: "bad_request" });
    }

    const b = body as Record<string, unknown>;

    if (!b.image || typeof b.image !== "string") {
      return openaiError(c, 400, "image is required", {
        code: "invalid_request_error",
        param: "image",
      });
    }

    if (!b.prompt || typeof b.prompt !== "string") {
      return openaiError(c, 400, "prompt is required", {
        code: "invalid_request_error",
        param: "prompt",
      });
    }

    const image = b.image as string;
    const prompt = b.prompt as string;

    try {
      const result = await editImage(deps, { image, prompt });

      const created = result.created;
      const data = result.urls.map((url) => ({ url }));

      return c.json({ created, data });
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return poolExhaustedResponse(c, err);
      }
      throw err;
    }
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
