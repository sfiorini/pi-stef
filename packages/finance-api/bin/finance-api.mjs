#!/usr/bin/env node
// finance-api service entry point
import { loadFinanceApiConfig, ensureToken, openDb, startServer, createLogger, loadSecrets, buildDefaultRegistry } from "../src/index.ts";

const log = createLogger();

async function main() {
  try {
    log.info("Starting finance-api service...");
    
    // Load config
    const config = await loadFinanceApiConfig();
    log.info("Config loaded", { port: config.port, dbPath: config.dbPath });
    
    // Ensure bearer token
    const token = await ensureToken(config.tokenPath);
    log.info("Token ready");
    
    // Open database
    const db = openDb(config.dbPath);
    log.info("Database opened");
    
    // Load secrets
    const secrets = loadSecrets(config.secretsPath);
    log.info("Secrets loaded", { providerCount: Object.keys(secrets).length });
    
    // Build provider registry
    const registry = buildDefaultRegistry();
    
    // Start server
    const server = await startServer({
      db,
      token,
      host: config.host,
      port: config.port,
      log,
    });
    
    log.info("Server started", { host: config.host, port: server.port });
    
    // Graceful shutdown
    const shutdown = () => {
      log.info("Shutting down...");
      server.close();
      db.close();
      process.exit(0);
    };
    
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    
  } catch (err) {
    log.error("Failed to start", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main();
