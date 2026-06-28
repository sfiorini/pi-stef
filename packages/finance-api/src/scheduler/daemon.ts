import type Database from "better-sqlite3";
import type { AdapterRegistry, IngestCreds } from "../ingest/registry";
import { runTick } from "./tick";
import { classifySession } from "../market/session";
import type { Logger } from "../server/logger";

export interface DaemonDeps {
  db: Database.Database;
  registry: AdapterRegistry;
  creds: IngestCreds;
  fetcher?: typeof fetch;
  log?: Logger;
  dataFeed?: "stooq" | "yfinance";
}

export interface DaemonHandle {
  stop: () => void;
}

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;

export function getNextTickDelay(session: string): number {
  switch (session) {
    case "pre":
      return 30 * MS_MINUTE; // Light: every 30 min
    case "intraday":
      return 30 * MS_MINUTE; // Active: every 30 min
    case "post":
      return MS_HOUR; // Post-market: hourly
    case "closed":
      return 4 * MS_HOUR; // Closed: every 4 hours (crypto only)
    default:
      return MS_HOUR;
  }
}

export function startDaemon(deps: DaemonDeps): DaemonHandle {
  const { log } = deps;
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (!running) return;

    try {
      const result = await runTick({ ...deps, dataFeed: deps.dataFeed });
      log?.info("daemon tick complete", result);
    } catch (err) {
      log?.error("daemon tick failed", { error: err instanceof Error ? err.message : String(err) });
    }

    if (!running) return;

    // Schedule next tick based on current session
    try {
      const session = classifySession(new Date());
      const delay = getNextTickDelay(session);
      log?.info("next tick scheduled", { session, delayMs: delay });
      timeoutId = setTimeout(tick, delay);
    } catch (err) {
      // If session classification fails (e.g., unsupported year), fall back to hourly
      log?.error("session classification failed, falling back to hourly", { error: err instanceof Error ? err.message : String(err) });
      timeoutId = setTimeout(tick, MS_HOUR);
    }
  }

  // Start first tick immediately
  tick();

  log?.info("daemon started");

  return {
    stop: () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      log?.info("daemon stopped");
    },
  };
}
