import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import path from "node:path";
import { runIngest, type AdapterRegistry } from "../../ingest/registry";
import { createFileAdapter } from "../../ingest/file";
import { createOpenApiSubApp } from "../openapi-helpers";
import { importResponse, errorResponse } from "../openapi-schemas";
import { ok, fail } from "../errors";

const importRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Data"],
  summary: "Import holdings from a CSV/OFX file",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ filePath: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: importResponse } },
      description: "Import complete",
    },
    400: {
      content: { "application/json": { schema: errorResponse } },
      description: "Bad request (missing filePath or directory traversal)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function importRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(importRoute, async (c) => {
    const { filePath } = c.req.valid("json");

    // Security: reject directory traversal (but allow absolute paths for local file imports)
    if (filePath.includes("..") && !path.isAbsolute(filePath)) {
      return c.json(fail("bad_request", "Directory traversal is not allowed"), 400);
    }

    // Create a one-shot file adapter for this import
    const fileRegistry: AdapterRegistry = new Map([
      ["import", createFileAdapter("import", "brokerage")],
    ]);
    const creds = { import: { filePath } };

    const result = await runIngest(db, fileRegistry, creds);
    return c.json(ok({ message: "Import complete", filePath, ...result }), 200);
  });
  return r;
}
