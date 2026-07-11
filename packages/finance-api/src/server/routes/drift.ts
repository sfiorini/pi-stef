import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listHoldings } from "../../store/repo";
import { computeDrift, type HoldingValued } from "../../quant/drift";
import { createOpenApiSubApp } from "../openapi-helpers";
import { driftResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const driftRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get allocation drift vs target",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: driftResponse } },
      description: "Drift analysis by asset class",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function driftRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();
  r.openapi(driftRoute, (c) => {
    const accounts = db.prepare("SELECT id FROM accounts").all() as { id: string }[];
    const holdingsValued: HoldingValued[] = [];

    for (const a of accounts) {
      const holdings = listHoldings(db, a.id);
      for (const h of holdings) {
        const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
        const price = priceRow?.close ?? h.avg_cost ?? 0;
        holdingsValued.push({
          symbol: h.symbol,
          assetClass: h.asset_class,
          quantity: h.quantity,
          price,
        });
      }
    }

    const goals = db.prepare("SELECT target_allocation FROM goals LIMIT 1").get() as { target_allocation: string } | undefined;
    const targetAllocation = goals ? JSON.parse(goals.target_allocation) : {};

    const drift = computeDrift(holdingsValued, { targetAllocation });
    return c.json(ok({ drift }), 200);
  });
  return r;
}
