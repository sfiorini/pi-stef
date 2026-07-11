import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { valueHoldings } from "../../valuation/value";
import { createOpenApiSubApp } from "../openapi-helpers";
import { allocationResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const allocationRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get allocation breakdown by asset class",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: allocationResponse } },
      description: "Allocation by asset class and total value",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function allocationRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(allocationRoute, (c) => {
    const valued = valueHoldings(db);
    const byClass = new Map<string, number>();
    let total = 0;
    for (const h of valued) {
      byClass.set(h.asset_class, (byClass.get(h.asset_class) ?? 0) + h.marketValue);
      total += h.marketValue;
    }
    const allocation = Object.fromEntries(
      [...byClass.entries()].map(([cls, value]) => [cls, total > 0 ? value / total : 0]),
    );
    return c.json(ok({ allocation, totalValue: total }), 200);
  });
  return r;
}
