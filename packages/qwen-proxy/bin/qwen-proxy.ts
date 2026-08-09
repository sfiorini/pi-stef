#!/usr/bin/env tsx
import { loadQwenProxyConfig, startServer, createLogger } from "../src/index";

const log = createLogger();

async function main() {
  try {
    log.info("Starting qwen-proxy service...");

    // Load config
    const config = await loadQwenProxyConfig();
    log.info("Config loaded", { port: config.port, dbPath: config.dbPath });

    // Start server
    const handle = await startServer({
      host: config.host,
      port: config.port,
      log,
    });

    log.info("qwen-proxy started", { port: handle.port });

    // Graceful shutdown
    const shutdown = () => {
      log.info("Shutting down...");
      handle.close();
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
