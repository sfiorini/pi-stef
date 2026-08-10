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
import type { UpstreamClient } from "../upstream/client";
import type { AuthScheduler } from "../upstream/auth";
import type { QwenProxyConfig } from "../config/types";
import type { Logger } from "./logger";
import type { withPoolRetry as WithPoolRetryFn } from "../pool/retry";
import type { withPoolRetryStream as WithPoolRetryStreamFn } from "../pool/retry";
import type { VideoPollDaemon } from "../media/video-daemon";
import type { MediaVideoDeps } from "../media/videos";
import { healthRoutes } from "./health";
import { clientAuthGate } from "./auth";
import { openaiRoutes, type OpenAIRouteDeps } from "../adapters/openai";

export interface AppDeps {
  db: Database.Database;
  pool: AccountPool;
  client: UpstreamClient;
  scheduler: Pick<AuthScheduler, "refreshOnDemand">;
  config: QwenProxyConfig;
  retry: typeof WithPoolRetryFn;
  retryStream: typeof WithPoolRetryStreamFn;
  media: MediaVideoDeps & { submitVideo: (params: { prompt: string; image?: string; model?: string }) => Promise<{ jobId: string }>; getVideoJob: (db: Database.Database, jobId: string) => import("../media/video-jobs").VideoJobRow | undefined };
  videoDaemon: VideoPollDaemon;
  log: Logger;
}

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

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
    submitVideo: (params) => deps.media.submitVideo(params),
    getVideoJob: (jobId) => deps.media.getVideoJob(deps.db, jobId),
  };

  app.route("/v1", openaiRoutes(openaiDeps));

  // 4. Anthropic routes (M3 — uncomment when ready)
  // app.route("/v1", anthropicRoutes(deps));

  return app;
}
