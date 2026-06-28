import type { RawHolding } from "./contract";
import { canonicalSymbol } from "../store/symbols";
import type { HoldingRow } from "../store/repo";

export interface NormalizeCtx { providerId: string; accountId: string }

export function normalizeHolding(ctx: NormalizeCtx, raw: RawHolding): HoldingRow & { lots?: { open_date: number; qty: number; cost_basis: number }[] } {
  if (raw.quantity < 0) throw new Error(`negative quantity for ${raw.symbol}`);
  const rounded = Math.round(raw.quantity * 1e6) / 1e6;
  const lots = raw.lots?.map((l) => ({ open_date: l.openDate, qty: Math.round(l.qty * 1e6) / 1e6, cost_basis: l.costBasis }));
  return {
    account_id: ctx.accountId,
    symbol: canonicalSymbol(raw.symbol, raw.assetClass),
    quantity: rounded,
    avg_cost: raw.avgCost ?? null,
    asset_class: raw.assetClass,
    subclass: raw.subclass ?? null,
    as_of: Date.now(),
    lots,
  };
}
