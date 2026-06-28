import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listHoldings } from "../../store/repo";
import { ok } from "../errors";

export function allocationRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const allHoldings = db.prepare("SELECT * FROM holdings").all() as { account_id: string; symbol: string; quantity: number; avg_cost: number | null; asset_class: string }[];
    const byClass = new Map<string, number>();
    let total = 0;
    for (const h of allHoldings) {
      const value = h.quantity * (h.avg_cost ?? 0);
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
