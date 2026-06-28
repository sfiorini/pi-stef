import { Hono } from "hono";
import type Database from "better-sqlite3";
import path from "node:path";
import { runIngest, type AdapterRegistry } from "../../ingest/registry";
import { createFileAdapter } from "../../ingest/file";
import { ok, fail } from "../errors";

export function importRoutes(db: Database.Database) {
  const r = new Hono();
  r.post("/", async (c) => {
    const { filePath } = await c.req.json();
    if (!filePath) return c.json(fail("bad_request", "Missing filePath"), 400);
    
    // Security: reject absolute paths and directory traversal
    if (path.isAbsolute(filePath)) {
      return c.json(fail("bad_request", "Absolute paths are not allowed"), 400);
    }
    if (filePath.includes("..")) {
      return c.json(fail("bad_request", "Directory traversal is not allowed"), 400);
    }
    
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
