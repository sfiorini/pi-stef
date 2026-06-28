import { Hono } from "hono";
import type Database from "better-sqlite3";
import { exportJson, backupDb } from "../../store/backup";
import { ok, fail } from "../errors";

export function exportRoutes(db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    const { format, path: backupPath } = await c.req.json();
    if (format === "json") {
      const data = exportJson(db);
      return c.json(ok(data));
    }
    if (format === "sqlite") {
      if (!backupPath) return c.json(fail("bad_request", "Missing path for sqlite export"), 400);
      await backupDb(db, backupPath);
      return c.json(ok({ backupPath }));
    }
    return c.json(fail("bad_request", "Invalid format (must be json or sqlite)"), 400);
  });
  return r;
}
