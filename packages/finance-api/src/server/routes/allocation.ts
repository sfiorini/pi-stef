import { Hono } from "hono";
import type Database from "better-sqlite3";
// listHoldings not needed - using direct SQL query
import { ok } from "../errors";

export function allocationRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const allHoldings = db.prepare("SELECT * FROM holdings").all() as { account_id: string; symbol: string; quantity: number; avg_cost: number | null; asset_class: string }[];
    const byClass = new Map<string, number>();
    let total = 0;
    for (const h of allHoldings) {
      // Use latest price from prices table if available, otherwise fall back to avg_cost
      const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
      const price = priceRow?.close ?? h.avg_cost ?? 0;
      const value = h.quantity * price;
      byClass.set(h.asset_class, (byClass.get(h.asset_class) ?? 0) + value);
      total += value;
    }
    const allocation = Object.fromEntries(
      [...byClass.entries()].map(([cls, value]) => [cls, total > 0 ? value / total : 0])
    );
    return c.json(ok({ allocation, totalValue: total }));
  });
  return r;
}
