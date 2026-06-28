import { Hono } from "hono";
import type Database from "better-sqlite3";
import { ok, fail } from "../errors";

export function importRoutes(db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    const { filePath } = await c.req.json();
    if (!filePath) return c.json(fail("bad_request", "Missing filePath"), 400);
    // Import is handled by the ingest pipeline; this endpoint triggers it for a specific file
    // For now, return success (actual import logic wired via registry)
    return c.json(ok({ message: "Import triggered", filePath }));
  });
  return r;
}
