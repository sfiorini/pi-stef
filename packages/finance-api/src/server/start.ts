import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createApp } from "./app";
import type { Logger } from "./logger";

export interface StartServerDeps {
  db: Database.Database;
  token: string;
  host?: string;
  port?: number;
  log?: Logger;
  registry?: import("../ingest/registry").AdapterRegistry;
  creds?: import("../ingest/registry").IngestCreds;
  fetcher?: typeof fetch;
  dataFeed?: "stooq" | "yfinance";
}

export interface ServerHandle {
  close: () => void;
  port: number;
}

export async function startServer(deps: StartServerDeps): Promise<ServerHandle> {
  const host = deps.host ?? "127.0.0.1";
  const port = deps.port ?? 7780;
  
  const app = createApp({ db: deps.db, token: deps.token, registry: deps.registry, creds: deps.creds, fetcher: deps.fetcher, dataFeed: deps.dataFeed });
  
  return new Promise((resolve, reject) => {
    try {
      const server = serve({
        fetch: app.fetch,
        hostname: host,
        port,
      }, (info) => {
        deps.log?.info("server started", { host, port: info.port });
        resolve({
          close: () => server.close(),
          port: info.port,
        });
      });
      
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use (EADDRINUSE)`));
        } else {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
