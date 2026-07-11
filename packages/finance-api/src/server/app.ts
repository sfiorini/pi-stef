import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import type Database from "better-sqlite3";
import { bearerAuth } from "./auth";
import { FINANCE_API_VERSION } from "../version";
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

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // Register security scheme
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Bearer token from ~/.pi/sf/finance/token",
  });

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

  // OpenAPI spec endpoint
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "finance-api",
      version: FINANCE_API_VERSION,
      description:
        "Always-on local service for portfolio tracking, drift analysis, and investment suggestions.",
    },
    servers: [{ url: "http://127.0.0.1:7780", description: "Local" }],
  });

  // Swagger UI
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}
