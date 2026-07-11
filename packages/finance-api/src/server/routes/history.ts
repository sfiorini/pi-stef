import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { createOpenApiSubApp } from "../openapi-helpers";
import { historyResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const historyRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get price history for a symbol",
  security: [{ BearerAuth: [] }],
  request: {
    query: z.object({
      symbol: z.string().min(1),
      accountId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: historyResponse } },
      description: "Price history rows",
    },
    400: {
      content: { "application/json": { schema: errorResponse } },
      description: "Missing symbol query param",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function historyRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(historyRoute, (c) => {
    const { symbol, accountId } = c.req.valid("query");

    let rows;
    if (accountId) {
      rows = db.prepare(`
        SELECT DISTINCT p.* FROM prices p
        JOIN holdings h ON h.symbol = p.symbol
        WHERE p.symbol = ? AND h.account_id = ?
        ORDER BY p.date DESC
      `).all(symbol, accountId) as Array<{ symbol: string; date: number; close: number; source: string }>;
    } else {
      rows = db.prepare("SELECT * FROM prices WHERE symbol=? ORDER BY date DESC").all(symbol) as Array<{ symbol: string; date: number; close: number; source: string }>;
    }
    return c.json(ok({ history: rows }), 200);
  });
  return r;
}
