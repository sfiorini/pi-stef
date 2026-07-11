import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { exportJson, backupDb } from "../../store/backup";
import { createOpenApiSubApp } from "../openapi-helpers";
import { errorResponse } from "../openapi-schemas";
import { ok } from "../errors";
import { globalDir } from "@pi-stef/paths";
import path from "node:path";
import { mkdirSync } from "node:fs";

const exportResponse = z.object({
  ok: z.literal(true),
  data: z.record(z.string(), z.unknown()),
});

const exportRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Data"],
  summary: "Export data (JSON dump or SQLite backup)",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            format: z.enum(["json", "sqlite"]),
            path: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: exportResponse } },
      description: "Export result",
    },
    400: {
      content: { "application/json": { schema: errorResponse } },
      description: "Invalid format",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function exportRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(exportRoute, async (c) => {
    const { format, path: requestedPath } = c.req.valid("json");

    if (format === "json") {
      const data = exportJson(db);
      return c.json(ok(data), 200);
    }

    // format === "sqlite" (Zod enum guarantees this)
    const backupDir = globalDir("finance");
    const filename = requestedPath ? path.basename(requestedPath) : `backup-${Date.now()}.db`;
    const backupPath = path.join(backupDir, "backups", filename);

    mkdirSync(path.dirname(backupPath), { recursive: true });

    await backupDb(db, backupPath);
    return c.json(ok({ backupPath }), 200);
  });
  return r;
}
