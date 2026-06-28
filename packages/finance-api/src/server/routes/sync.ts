import { Hono } from "hono";
import type Database from "better-sqlite3";
import { ok } from "../errors";

export function syncRoutes(_db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    // Sync is handled by the scheduler; this endpoint triggers an immediate tick
    // For now, return success (actual sync logic wired in M9)
    return c.json(ok({ message: "Sync triggered" }));
  });
  return r;
}
