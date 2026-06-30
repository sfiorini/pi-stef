import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { AdapterRegistry, IngestCreds } from "../../ingest/registry";
import { runTick } from "../../scheduler/tick";
import { ok } from "../errors";

export interface SyncDeps {
  registry: AdapterRegistry;
  creds: IngestCreds;
  fetcher?: typeof fetch;
  dataFeed?: "stooq" | "yfinance";
}

export function syncRoutes(db: Database.Database, deps: SyncDeps) {
  const r = new Hono();
  r.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { providers?: string[]; credentials?: IngestCreds };
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
    return c.json(ok({ message: "Sync complete", ...result }));
  });
  return r;
}
