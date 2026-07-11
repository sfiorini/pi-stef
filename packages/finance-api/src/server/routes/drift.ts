import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { valueHoldings } from "../../valuation/value";
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
    const valued = valueHoldings(db);
    const holdingsValued: HoldingValued[] = valued.map(v => ({
      symbol: v.symbol,
      assetClass: v.asset_class,
      quantity: v.quantity,
      price: v.price,
    }));

    const goals = db.prepare("SELECT target_allocation FROM goals LIMIT 1").get() as { target_allocation: string } | undefined;
    const targetAllocation = goals ? JSON.parse(goals.target_allocation) : {};

    const drift = computeDrift(holdingsValued, { targetAllocation });
    return c.json(ok({ drift }), 200);
  });
  return r;
}
