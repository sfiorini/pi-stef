import { Hono } from "hono";
import type Database from "better-sqlite3";
import { bearerAuth } from "./auth";
import { marketStatusRoutes } from "./routes/market-status";
import { holdingsRoutes } from "./routes/holdings";
import { netWorthRoutes } from "./routes/net-worth";
import { allocationRoutes } from "./routes/allocation";
import { goalsRoutes } from "./routes/goals";
import { suggestionsRoutes } from "./routes/suggestions";
import { syncRoutes } from "./routes/sync";
import { importRoutes } from "./routes/import-route";
import { historyRoutes } from "./routes/history";
import { healthRoutes } from "./health";
import { exportRoutes } from "./routes/export";
import { driftRoutes } from "./routes/drift";

export interface AppDeps {
  db: Database.Database;
  token: string;
  registry?: import("../ingest/registry").AdapterRegistry;
  creds?: import("../ingest/registry").IngestCreds;
  fetcher?: typeof fetch;
  dataFeed?: "stooq" | "yfinance";
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  
  // Health endpoint is public (no auth)
  app.route("/v1/health", healthRoutes());
  
  // All other /v1 routes require bearer token
  app.use("/v1/*", bearerAuth(deps.token));
  
  // Mount routes
  app.route("/v1/market-status", marketStatusRoutes());
  app.route("/v1/holdings", holdingsRoutes(deps.db));
  app.route("/v1/net-worth", netWorthRoutes(deps.db));
  app.route("/v1/allocation", allocationRoutes(deps.db));
  app.route("/v1/goals", goalsRoutes(deps.db));
  app.route("/v1/suggestions", suggestionsRoutes(deps.db));
  app.route("/v1/sync", syncRoutes(deps.db, {
    registry: deps.registry ?? new Map(),
    creds: deps.creds ?? {},
    fetcher: deps.fetcher,
    dataFeed: deps.dataFeed,
  }));
  app.route("/v1/import", importRoutes(deps.db));
  app.route("/v1/history", historyRoutes(deps.db));
  app.route("/v1/export", exportRoutes(deps.db));
  app.route("/v1/drift", driftRoutes(deps.db));
  
  return app;
}
