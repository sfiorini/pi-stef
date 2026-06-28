export interface HoldingValued { symbol: string; assetClass: string; quantity: number; price: number }

export interface DriftRow { class: string; currentPct: number; targetPct: number; deltaPct: number; value: number }

export function computeDrift(holdings: HoldingValued[], target: { targetAllocation: Record<string, number> }): DriftRow[] {
  const total = holdings.reduce((a, h) => a + h.quantity * h.price, 0);
  if (total === 0) return [];
  const byClass = new Map<string, number>();
  for (const h of holdings) byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + h.quantity * h.price);

  const classes = new Set([...byClass.keys(), ...Object.keys(target.targetAllocation)]);
  return [...classes].map((c) => {
    const value = byClass.get(c) ?? 0;
    const currentPct = value / total;
    const targetPct = target.targetAllocation[c] ?? 0;
    return { class: c, currentPct, targetPct, deltaPct: currentPct - targetPct, value };
  });
}
