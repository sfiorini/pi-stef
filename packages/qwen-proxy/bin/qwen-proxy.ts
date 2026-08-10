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

    // Auth scheduler (per-account JWT refresh + on-demand 401)
    const client = createUpstreamClient({
      authUrl: config.authUrl,
      apiUrl: config.apiUrl,
      cookies: () => cookies.get(),
      timeoutMs: config.loginTimeoutMs,
    });

    const scheduler = new AuthScheduler({
      db,
      config,
      cookies,
      login: client.login,
      log,
    });
    await scheduler.start();

    // Start HTTP server
    const handle = await startServer({
      host: config.host,
      port: config.port,
      log,
    });

    log.info("qwen-proxy started", { port: handle.port });

    // Graceful shutdown: reenableDaemon.stop BEFORE scheduler.stop BEFORE db.close
    const shutdown = () => {
      log.info("shutting down");
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
