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
    const result = await runTick({
      db,
      registry: deps.registry,
      creds: deps.creds,
      fetcher: deps.fetcher,
      dataFeed: deps.dataFeed,
    });
    return c.json(ok({ message: "Sync complete", ...result }));
  });
  return r;
}
