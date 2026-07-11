import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listAccounts, listHoldings } from "../../store/repo";
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
    const accounts = listAccounts(db);
    let totalValue = 0;
    for (const a of accounts) {
      const holdings = listHoldings(db, a.id);
      for (const h of holdings) {
        const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
        const price = priceRow?.close ?? h.avg_cost ?? 0;
        totalValue += h.quantity * price;
      }
    }
    return c.json(ok({ netWorth: totalValue, accountCount: accounts.length }), 200);
  });
  return r;
}
