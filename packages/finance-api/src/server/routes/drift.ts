import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listHoldings } from "../../store/repo";
import { computeDrift, type HoldingValued } from "../../quant/drift";
import { ok } from "../errors";

export function driftRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    // Get all holdings with latest prices
    const accounts = db.prepare("SELECT id FROM accounts").all() as { id: string }[];
    const holdingsValued: HoldingValued[] = [];
    
    for (const a of accounts) {
      const holdings = listHoldings(db, a.id);
      for (const h of holdings) {
        // Get latest price from prices table, fall back to avg_cost
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
    
    // Get goals for target allocation
    const goals = db.prepare("SELECT target_allocation FROM goals LIMIT 1").get() as { target_allocation: string } | undefined;
    const targetAllocation = goals ? JSON.parse(goals.target_allocation) : {};
    
    const drift = computeDrift(holdingsValued, { targetAllocation });
    return c.json(ok({ drift }));
  });
  return r;
}
