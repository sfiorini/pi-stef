import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { computeNetWorth } from "../../valuation/value";
import { createOpenApiSubApp } from "../openapi-helpers";
import { netWorthResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const netWorthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get total net worth across all accounts",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: netWorthResponse } },
      description: "Net worth and account count",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function netWorthRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(netWorthRoute, (c) => {
    const { netWorth, accountCount } = computeNetWorth(db);
    return c.json(ok({ netWorth, accountCount }), 200);
  });
  return r;
}
