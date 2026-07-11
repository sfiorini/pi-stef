import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
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
    const allHoldings = db.prepare("SELECT * FROM holdings").all() as { account_id: string; symbol: string; quantity: number; avg_cost: number | null; asset_class: string }[];
    const byClass = new Map<string, number>();
    let total = 0;
    for (const h of allHoldings) {
      const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
      const price = priceRow?.close ?? h.avg_cost ?? 0;
      const value = h.quantity * price;
      byClass.set(h.asset_class, (byClass.get(h.asset_class) ?? 0) + value);
      total += value;
    }
    const allocation = Object.fromEntries(
      [...byClass.entries()].map(([cls, value]) => [cls, total > 0 ? value / total : 0]),
    );
    return c.json(ok({ allocation, totalValue: total }), 200);
  });
  return r;
}
