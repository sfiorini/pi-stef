import { Hono } from "hono";
import type Database from "better-sqlite3";
import { runIngest, type AdapterRegistry } from "../../ingest/registry";
import { createFileAdapter } from "../../ingest/file";
import { ok, fail } from "../errors";

export function importRoutes(db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    const { filePath } = await c.req.json();
    if (!filePath) return c.json(fail("bad_request", "Missing filePath"), 400);
    
    // Create a one-shot file adapter for this import
    const fileRegistry: AdapterRegistry = new Map([
      ["import", createFileAdapter("import", "brokerage")],
    ]);
    const creds = { import: { filePath } };
    
    const result = await runIngest(db, fileRegistry, creds);
    return c.json(ok({ message: "Import complete", filePath, ...result }));
  });
  return r;
}
