/**
 * Application factory.
 *
 * createApp(deps) builds the full Hono app:
 *   1. /v1/health (PUBLIC — before auth gate)
 *   2. /v1/* auth gate (clientAuthGate)
 *   3. /v1 OpenAI-compatible routes (openaiRoutes)
 *   4. /v1 Anthropic routes (M3 — anthropicRoutes)
 *
 * The deps object carries all runtime dependencies (db, pool, client, etc.)
 * so startServer / tests can inject them.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import type { AccountPool } from "../pool/state";
import type { UpstreamClient, ImageResult } from "../upstream/client";
import type { AuthScheduler } from "../upstream/auth";
import type { QwenProxyConfig } from "../config/types";
import type { Logger } from "./logger";
import type { withPoolRetry as WithPoolRetryFn } from "../pool/retry";
import type { withPoolRetryStream as WithPoolRetryStreamFn } from "../pool/retry";
import { healthRoutes } from "./health";
import { clientAuthGate } from "./auth";
import { openaiRoutes, type OpenAIRouteDeps } from "../adapters/openai";
import { anthropicRoutes, type AnthropicRouteDeps } from "../adapters/anthropic";
import { adminRoutes } from "./admin-routes";
import { openaiError } from "../adapters/openai/errors";
import { anthropicError } from "../adapters/anthropic/errors";
import {
  ClientError,
  AuthExpiredError,
  RateLimitError,
  ServerError,
  NetworkError,
  UnknownError,
} from "../upstream/errors";

export interface AppDeps {
  db: Database.Database;
  pool: AccountPool;
  client: UpstreamClient;
  scheduler: Pick<AuthScheduler, "refreshOnDemand">;
  config: QwenProxyConfig;
  retry: typeof WithPoolRetryFn;
  retryStream: typeof WithPoolRetryStreamFn;
  // media: bin-passthrough field for image routes (MediaImageDeps subset).
  // Not consumed directly by createApp; exists so bin can pass runtime deps.
  media: { client: UpstreamClient; retry: typeof WithPoolRetryFn; pool: AccountPool; scheduler: Pick<AuthScheduler, "refreshOnDemand">; config: QwenProxyConfig; log: Logger };
  // video: bin-passthrough field for the synchronous video endpoint.
  // Not consumed directly by createApp; exists so bin can pass the wired generateVideo closure.
  video: { generateVideo: (params: { prompt: string; size?: string }) => Promise<ImageResult> };
  log: Logger;
}

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // A3: Global error handler — map QwenUpstreamError subclasses to
  // surface-appropriate envelope + status.
  app.onError((err, c) => {
    const isAnthropic = c.req.path.startsWith("/v1/messages");

    // Surface every unhandled request error. Without this the generic-500
    // branch was completely silent, making request failures undiagnosable.
    deps.log.error("request failed", {
      path: c.req.path,
      method: c.req.method,
      kind: err?.constructor?.name,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });

    if (err instanceof ClientError) {
      return isAnthropic
        ? anthropicError(c, 400, undefined, err.message)
        : openaiError(c, 400, err.message);
    }
    if (err instanceof AuthExpiredError) {
      return isAnthropic
        ? anthropicError(c, 401, undefined, err.message)
        : openaiError(c, 401, err.message);
    }
    if (err instanceof RateLimitError) {
      return isAnthropic
        ? anthropicError(c, 429, undefined, err.message)
        : openaiError(c, 429, err.message);
    }
    if (err instanceof ServerError) {
      return isAnthropic
        ? anthropicError(c, 502, undefined, err.message)
        : openaiError(c, 502, err.message);
    }
    if (err instanceof NetworkError) {
      return isAnthropic
        ? anthropicError(c, 503, undefined, err.message)
        : openaiError(c, 503, err.message);
    }
    if (err instanceof UnknownError) {
      return isAnthropic
        ? anthropicError(c, 500, undefined, err.message)
        : openaiError(c, 500, err.message);
    }

    // Non-QwenUpstreamError → generic 500
    if (isAnthropic) {
      return anthropicError(c, 500, "api_error", "Internal server error");
    }
    return openaiError(c, 500, "Internal server error");
  });

  // 1. Health endpoint is public (no auth)
  app.route("/v1/health", healthRoutes());

  // 2. Auth gate on /v1/* (exempts /v1/health because it's mounted above)
  app.use(
    "/v1/*",
    clientAuthGate({
      db: deps.db,
      envKeys: deps.config.apiKeyEnv,
      log: deps.log,
    }),
  );

  // 3. OpenAI-compatible routes
  const openaiDeps: OpenAIRouteDeps = {
    pool: deps.pool,
    scheduler: deps.scheduler,
    config: deps.config,
    configModels: deps.config,
    log: deps.log,
    client: deps.client,
    retry: deps.retry,
    retryStream: deps.retryStream,
    video: deps.video,
  };

  app.route("/v1", openaiRoutes(openaiDeps));

  // 4. Anthropic-compatible routes
  const anthropicDeps: AnthropicRouteDeps = {
    pool: deps.pool,
    scheduler: deps.scheduler,
    config: { rateLimitCooldownMs: deps.config.rateLimitCooldownMs, modelAliasesRaw: deps.config.modelAliasesRaw ?? "" },
    log: deps.log,
    client: deps.client,
    retry: deps.retry,
    retryStream: deps.retryStream,
  };
  app.route("/v1", anthropicRoutes(anthropicDeps));

  // 5. Admin dashboard (NOT under /v1/* — bypasses clientAuthGate; gated by adminGate inside the sub-app)
  app.route("/admin", adminRoutes({ db: deps.db, adminKey: deps.config.adminKey, log: deps.log }));

  return app;
}
