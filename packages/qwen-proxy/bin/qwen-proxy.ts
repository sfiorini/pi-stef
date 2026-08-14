#!/usr/bin/env tsx
import {
  loadQwenProxyConfig,
  startServer,
  createLogger,
  openDb,
} from "../src/index";
import { BaxiaTokenManager } from "../src/upstream/baxia-token";
import { GuestUpstreamClient } from "../src/upstream/guest-client";
import { ProxyBridge } from "../src/upstream/proxy-bridge";
import { SingleAccountPool } from "../src/pool/single";
import { withPoolRetry } from "../src/pool/retry";
import { withPoolRetryStream } from "../src/pool/retry";
import { createProxyPool, ProxyDispatcherCache } from "../src/pool/proxy-pool";
import { RequestThrottle } from "../src/pool/throttle";
import { Semaphore } from "../src/pool/semaphore";
import type { AppDeps } from "../src/server/app";

const CHAT_URL = "https://chat.qwen.ai";

const log = createLogger();

async function main() {
  try {
    log.info("Starting qwen-proxy service...");

    // Load config
    const config = await loadQwenProxyConfig();
    log.info("Config loaded", { port: config.port, dbPath: config.dbPath });

    // Open DB (mkdir + foreign_keys ON + migrations)
    const db = openDb(config.dbPath);

    // Baxia token manager (Chrome CDP for guest Baxia tokens)
    const baxia = new BaxiaTokenManager({
      chatUrl: CHAT_URL,
      chromePath: config.baxia.chromePath,
      cacheTtlMs: config.baxia.cacheTtlMs,
      baxiaVersion: config.baxia.baxiaVersion,
      fallback: config.baxia.fallback,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      log,
    });

    // Proxy pool rotation (NordVPN SOCKS5)
    let proxyPool;
    let proxyDispatcherCache;
    let bridge: ProxyBridge | undefined;
    if (config.proxyCount > 1 || config.proxyUrlsRaw.trim()) {
      proxyPool = await createProxyPool({
        proxyCount: config.proxyCount,
        proxyUrlsRaw: config.proxyUrlsRaw,
        proxyUser: config.proxyUser,
        proxyPass: config.proxyPass,
        proxyCountriesRaw: config.proxyCountriesRaw,
        fetcher: globalThis.fetch,
        log,
      });
      if (proxyPool.size > 0) {
        proxyDispatcherCache = new ProxyDispatcherCache();
        // S-M2-2: start loopback SOCKS5 bridge for proxy-affine token gen
        bridge = new ProxyBridge({ log });
        await bridge.start();
        baxia.setBridge(bridge);
        log.info("proxy-affine bridge started", { port: bridge.getPort() });
        log.info("proxy rotation enabled", { size: proxyPool.size });
      } else {
        proxyPool = undefined;
        log.warn("proxy pool empty — legacy");
      }
    }

    // Pre-warm: eagerly fetch the first token so the server starts ready.
    // In rotation mode (bridge set), skip pre-warm — the lazy on-demand refresh
    // handles the first proxy's token when the first request arrives. Pre-warming
    // with no proxy would mint a DIRECT_KEY token via direct Chromium (wasteful).
    if (config.baxia.preWarm && !bridge) {
      try {
        await baxia.ensureToken();
        log.info("baxia pre-warm succeeded");
      } catch (e) {
        log.error("baxia pre-warm failed", { error: String(e) });
        process.exit(1);
      }
    }

    // Start background refresh loop (S-M2-2: no-op when bridge set — lazy per-proxy)
    baxia.startRefreshLoop();

    // Cap concurrent chat.qwen.ai calls — Baxia flags the IP on concurrent
    // upstream connections. Default 1 (serialize, like the web chat); tune with SF_QWEN_MAX_CONCURRENCY.
    const concurrency = new Semaphore(config.maxConcurrency);
    const client = new GuestUpstreamClient({ baxia, chatUrl: CHAT_URL, concurrency, log, proxyDispatcherCache, timeoutMs: config.timeoutMs });

    // Re-create client with proxy dispatcher cache + timeout if rotation enabled
    const finalClient = proxyDispatcherCache
      ? new GuestUpstreamClient({ baxia, chatUrl: CHAT_URL, concurrency, log, proxyDispatcherCache, timeoutMs: config.timeoutMs })
      : client;

    // Single-account pool shim (guest mode: one virtual account, no failover)
    const pool = new SingleAccountPool({ log });

    // No-op auth scheduler (guest has no JWT to refresh)
    const scheduler = {
      refreshOnDemand: async () => ({ bearer: "guest", expiresAt: null }),
      // Rotate the Baxia token on empty-exhaustion: in guest mode the token/session
      // can get flagged by Baxia, and a fresh Chromium spawn recovers it without a restart.
      refreshBaxiaToken: async () => { await baxia.ensureToken({ forceRefresh: true }); },
    };

    // Per-account request throttle (look-human): paces dispatches to reduce
    // Baxia CAPTCHA flagging. minGapMs=0 disables.
    const throttle = new RequestThrottle({ minGapMs: config.minRequestGapMs });

    // Build AppDeps for createApp/startServer
    const deps: AppDeps = {
      db,
      pool,
      client: finalClient,
      scheduler,
      config,
      retry: withPoolRetry,
      retryStream: withPoolRetryStream,
      throttle,
      log,
      baxiaStatus: () => baxia.status(),
      ...(proxyPool ? { proxyPool } : {}),
    };

    // Start HTTP server
    const handle = await startServer({
      ...deps,
      host: config.host,
      port: config.port,
    });

    log.info("qwen-proxy started", { port: handle.port });

    // Graceful shutdown: drain HTTP → baxia → bridge → db
    const shutdown = async () => {
      log.info("shutting down");
      handle.close();
      baxia.stop();
      if (bridge) await bridge.stop();
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
