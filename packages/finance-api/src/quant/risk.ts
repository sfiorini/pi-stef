import type { HoldingValued } from "./drift";

export interface RiskFlag { kind: "concentration" | "cashDrag"; symbol?: string; value: number; limit: number }

export function checkRisk(
  holdings: HoldingValued[],
  goal: { riskLimits: Record<string, number>; cashAvailable?: number },
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const total = holdings.reduce((a, h) => a + h.quantity * h.price, 0) + (goal.cashAvailable ?? 0);
  if (total === 0) return flags;
  const maxPos = goal.riskLimits.maxSinglePosition;
  if (maxPos) {
    for (const h of holdings) {
      const pct = (h.quantity * h.price) / total;
      if (pct > maxPos) flags.push({ kind: "concentration", symbol: h.symbol, value: pct, limit: maxPos });
    }
  }
  const cashPct = (goal.cashAvailable ?? 0) / total;
  const maxCash = goal.riskLimits.maxCashDrag;
  if (maxCash && cashPct > maxCash) flags.push({ kind: "cashDrag", value: cashPct, limit: maxCash });
  return flags;
}
