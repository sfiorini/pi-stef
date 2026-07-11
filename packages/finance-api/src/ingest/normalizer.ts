import type { RawHolding } from "./contract";
import { canonicalSymbol } from "../store/symbols";
import type { HoldingRow } from "../store/repo";

export interface NormalizeCtx { providerId: string; accountId: string; asOf?: number }

export function normalizeHolding(ctx: NormalizeCtx, raw: RawHolding): HoldingRow & { lots?: { open_date: number; qty: number; cost_basis: number }[] } {
  if (raw.quantity < 0) throw new Error(`negative quantity for ${raw.symbol}`);
  const rounded = Math.round(raw.quantity * 1e6) / 1e6;
  const lots = raw.lots?.map((l) => ({ open_date: l.openDate, qty: Math.round(l.qty * 1e6) / 1e6, cost_basis: l.costBasis }));
  // When the provider flags a position as a cash equivalent (e.g. money market
  // sweep funds like SPAXX/FDRXX), override assetClass to "cash" regardless of
  // what the adapter initially set. This keeps the classification provider-generic:
  // any adapter that sets cashEquivalent: true gets the same treatment.
  const assetClass = raw.cashEquivalent === true ? "cash" : raw.assetClass;
  return {
    account_id: ctx.accountId,
    symbol: canonicalSymbol(raw.symbol, assetClass),
    quantity: rounded,
    avg_cost: raw.avgCost ?? null,
    asset_class: assetClass,
    subclass: raw.subclass ?? null,
    price: raw.price ?? null,
    security_type: raw.securityType ?? null,
    as_of: ctx.asOf ?? Date.now(),
    lots,
  };
}
