import type { HoldingValued } from "./drift";

export interface RebalanceInput { cashAvailable: number; minTradeDollars: number; lotPolicy?: "fifo" | "ltf" }
export interface RebalanceOrder { symbol: string; side: "buy" | "sell"; dollars: number; estQty: number }

export function computeRebalance(
  holdings: HoldingValued[],
  target: { targetAllocation: Record<string, number> },
  input: RebalanceInput,
): RebalanceOrder[] {
  const total = holdings.reduce((a, h) => a + h.quantity * h.price, 0) + input.cashAvailable;
  const orders: RebalanceOrder[] = [];

  // per-class target dollars
  const targetByClass = new Map<string, number>();
  for (const [c, pct] of Object.entries(target.targetAllocation)) targetByClass.set(c, pct * total);

  // current by class
  const currentByClass = new Map<string, number>();
  for (const h of holdings) currentByClass.set(h.assetClass, (currentByClass.get(h.assetClass) ?? 0) + h.quantity * h.price);
  currentByClass.set("cash", input.cashAvailable);

  for (const [cls, targetDollars] of targetByClass) {
    const current = currentByClass.get(cls) ?? 0;
    const diff = targetDollars - current;
    if (Math.abs(diff) < input.minTradeDollars) continue;
    if (cls === "cash") continue; // cash is the residual; not a tradable order
    // distribute the class diff proportionally across that class's holdings
    const classHoldings = holdings.filter((h) => h.assetClass === cls);
    const classValue = classHoldings.reduce((a, h) => a + h.quantity * h.price, 0) || 1;
    
    if (classHoldings.length === 0 && diff > input.minTradeDollars) {
      // No holdings in this class yet — emit a placeholder buy order
      // The agent will need to recommend a specific instrument
      orders.push({ symbol: `[${cls}]`, side: "buy", dollars: diff, estQty: 0 });
    } else {
      for (const h of classHoldings) {
        const share = (h.quantity * h.price) / classValue;
        const d = diff * share;
        if (Math.abs(d) < input.minTradeDollars) continue;
        orders.push({ symbol: h.symbol, side: d > 0 ? "buy" : "sell", dollars: Math.abs(d), estQty: Math.abs(d) / h.price });
      }
    }
  }
  return orders;
}
