import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listAccounts, listHoldings } from "../../store/repo";
import { createOpenApiSubApp } from "../openapi-helpers";
import { holdingsResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const listHoldingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get all account holdings",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: holdingsResponse } },
      description: "All accounts with their holdings",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function holdingsRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(listHoldingsRoute, (c) => {
    const accounts = listAccounts(db).map((a) => ({
      ...a,
      holdings: listHoldings(db, a.id),
    }));
    return c.json(ok({ accounts }), 200);
  });
  return r;
}
