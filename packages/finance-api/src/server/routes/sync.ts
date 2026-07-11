import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import type { AdapterRegistry, IngestCreds } from "../../ingest/registry";
import { runTick } from "../../scheduler/tick";
import { createOpenApiSubApp } from "../openapi-helpers";
import { syncResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

export interface SyncDeps {
  registry: AdapterRegistry;
  creds: IngestCreds;
  fetcher?: typeof fetch;
  dataFeed?: "stooq" | "yfinance";
}

const syncRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Data"],
  summary: "Trigger a sync tick (ingest + prices + quant)",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              providers: z.array(z.string()).optional(),
              credentials: z.record(z.string(), z.unknown()).optional(),
            })
            .optional()
            .default({}),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: syncResponse } },
      description: "Sync complete",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function syncRoutes(db: Database.Database, deps: SyncDeps) {
  const r = createOpenApiSubApp();
  r.openapi(syncRoute, async (c) => {
    const body = c.req.valid("json") as { providers?: string[]; credentials?: IngestCreds };
    // Shallow merge into a NEW object — request creds win (provider-level replacement),
    // server's deps.creds is never mutated. Nothing is persisted.
    const mergedCreds: IngestCreds = { ...deps.creds, ...body.credentials };
    const result = await runTick({
      db,
      registry: deps.registry,
      creds: mergedCreds,
      providers: body.providers,
      fetcher: deps.fetcher,
      dataFeed: deps.dataFeed,
    });
    return c.json(ok({ message: "Sync complete", ...result }), 200);
  });
  return r;
}
