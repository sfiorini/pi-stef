#!/usr/bin/env tsx
import {
  loadQwenProxyConfig,
  startServer,
  createLogger,
  openDb,
  reconcileAccounts,
  CookieJar,
  AuthScheduler,
  createUpstreamClient,
} from "../src/index";
import { AccountPool } from "../src/pool/state";
import { ReenableDaemon } from "../src/pool/reenable-daemon";
import { withPoolRetry } from "../src/pool/retry";
import { withPoolRetryStream } from "../src/pool/retry";
import { VideoPollDaemon } from "../src/media/video-daemon";
import { submitVideo, getVideoJob } from "../src/media/videos";
import type { AppDeps } from "../src/server/app";

const log = createLogger();

async function main() {
  try {
    log.info("Starting qwen-proxy service...");

    // Load config
    const config = await loadQwenProxyConfig();
    log.info("Config loaded", { port: config.port, dbPath: config.dbPath });

    // Open DB (mkdir + foreign_keys ON + migrations)
    const db = openDb(config.dbPath);

    // Reconcile accounts with config
    const stats = reconcileAccounts(db, config.accounts);
    log.info("accounts reconciled", stats);

    // Pool hydration (after reconcile, before routes)
    const pool = new AccountPool({ db, log });
    pool.hydrate();

    // Reenable daemon (back-of-queue sweep)
    const reenableDaemon = new ReenableDaemon({
      pool,
      intervalMs: config.reenableIntervalMs,
      log,
    });
    reenableDaemon.start();

    // Cookie jar (15-min ssxmod refresh)
    const cookies = new CookieJar(config.refreshIntervalMs);
    // NOTE: cookies.start() is called inside AuthScheduler.start()

    // Upstream client
    const client = createUpstreamClient({
      authUrl: config.authUrl,
      apiUrl: config.apiUrl,
      cookies: () => cookies.get(),
      timeoutMs: config.loginTimeoutMs,
    });

    // Auth scheduler (per-account JWT refresh + on-demand 401)
    const scheduler = new AuthScheduler({
      db,
      config,
      cookies,
      login: client.login,
      log,
    });
    await scheduler.start();

    // Build retry deps (shared by pool, media, routes)
    const retryDeps = { pool, scheduler, config, log };

    // Media deps (shared by images and video)
    const mediaDeps = {
      ...retryDeps,
      db,
      client,
      retry: withPoolRetry,
    };

    // Video poll daemon (background status polling)
    const videoDaemon = new VideoPollDaemon({
      db,
      pool,
      client,
      retry: withPoolRetry,
      scheduler,
      config,
      log,
      intervalMs: 20_000,
    });
    videoDaemon.start();

    // Build AppDeps for createApp/startServer
    const deps: AppDeps = {
      db,
      pool,
      client,
      scheduler,
      config,
      retry: withPoolRetry,
      retryStream: withPoolRetryStream,
      media: {
        ...mediaDeps,
        submitVideo: (params) => submitVideo(mediaDeps, params),
        getVideoJob: (dbRef, jobId) => getVideoJob(dbRef, jobId),
      },
      videoDaemon,
      log,
    };

    // Start HTTP server
    const handle = await startServer({
      ...deps,
      host: config.host,
      port: config.port,
    });

    log.info("qwen-proxy started", { port: handle.port });

    // Graceful shutdown order:
    // videoDaemon → reenableDaemon → scheduler → cookies → server → db
    const shutdown = () => {
      log.info("shutting down");
      videoDaemon.stop();
      reenableDaemon.stop();
      scheduler.stop();
      cookies.stop();
      handle.close();
      db.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    log.error("Failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();
