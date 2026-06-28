import { Hono } from "hono";
import type Database from "better-sqlite3";
import { exportJson, backupDb } from "../../store/backup";
import { ok, fail } from "../errors";
import { globalDir } from "@pi-stef/paths";
import path from "node:path";
import { mkdirSync } from "node:fs";

export function exportRoutes(db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    const { format, path: requestedPath } = await c.req.json();
    if (format === "json") {
      const data = exportJson(db);
      return c.json(ok(data));
    }
    if (format === "sqlite") {
      // Restrict backup path to the finance directory for security
      const backupDir = globalDir("finance");
      const filename = requestedPath ? path.basename(requestedPath) : `backup-${Date.now()}.db`;
      const backupPath = path.join(backupDir, "backups", filename);
      
      // Ensure backup directory exists
      mkdirSync(path.dirname(backupPath), { recursive: true });
      
      await backupDb(db, backupPath);
      return c.json(ok({ backupPath }));
    }
    return c.json(fail("bad_request", "Invalid format (must be json or sqlite)"), 400);
  });
  return r;
}
