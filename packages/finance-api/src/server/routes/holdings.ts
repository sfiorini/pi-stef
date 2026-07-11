import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listAccounts, listHoldings } from "../../store/repo";
import { valueHolding, computeUnbilledCash } from "../../valuation/value";
import { createOpenApiSubApp } from "../openapi-helpers";
import { holdingsResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const listHoldingsQuery = z.object({
  accountId: z.string().optional(),
  symbol: z.string().optional(),
});

const listHoldingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Portfolio"],
  summary: "Get all account holdings",
  security: [{ BearerAuth: [] }],
  request: {
    query: listHoldingsQuery,
  },
  responses: {
    200: {
      content: { "application/json": { schema: holdingsResponse } },
      description: "All accounts with their holdings (including price, marketValue, and account totalValue)",
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
    const { accountId, symbol } = c.req.valid("query");

    let accounts = listAccounts(db);
    if (accountId) accounts = accounts.filter(a => a.id === accountId);

    const result = accounts.map((a) => {
      let holdings = listHoldings(db, a.id);
      if (symbol) holdings = holdings.filter(h => h.symbol === symbol);

      const valued = holdings.map(h => {
        const v = valueHolding(db, h);
        const costBasis = h.avg_cost != null ? h.avg_cost * h.quantity : null;
        return {
          account_id: h.account_id,
          symbol: h.symbol,
          quantity: h.quantity,
          avg_cost: h.avg_cost,
          asset_class: h.asset_class,
          subclass: h.subclass,
          price: v.price,
          security_type: h.security_type ?? null,
          market_value: v.marketValue,
          gain_loss: costBasis != null ? v.marketValue - costBasis : null,
          as_of: h.as_of,
        };
      });

      const holdingsTotal = valued.reduce((sum, h) => sum + h.market_value, 0);
      const unbilledCash = computeUnbilledCash(db, a.id);

      return {
        ...a,
        total_value: holdingsTotal + unbilledCash,
        holdings: valued,
      };
    });

    return c.json(ok({ accounts: result }), 200);
  });
  return r;
}
