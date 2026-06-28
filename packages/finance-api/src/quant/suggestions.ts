import type { DriftRow } from "./drift";
import type { RebalanceOrder } from "./rebalance";
import type { RiskFlag } from "./risk";
import type { DcaResult } from "./dca";
import type { Session } from "../market/session";

export interface SuggestionRecord {
  id: string; createdAt: number; marketSession: Session;
  kind: "drift" | "rebalance" | "risk" | "cashDrag" | "dca"; payload: unknown;
}

export interface SuggestionInput {
  drift: DriftRow[]; rebalance: RebalanceOrder[]; risk: RiskFlag[]; dca: DcaResult[];
  session: Session; now: number;
}

export function buildSuggestions(input: SuggestionInput): SuggestionRecord[] {
  const { drift, rebalance, risk, dca, session, now } = input;
  const recs: SuggestionRecord[] = [];
  let n = 0;
  const mk = (kind: SuggestionRecord["kind"], payload: unknown): SuggestionRecord => ({ id: `s-${now}-${n++}`, createdAt: now, marketSession: session, kind, payload });
  for (const d of drift) if (Math.abs(d.deltaPct) > 0.02) recs.push(mk("drift", d));
  for (const r of rebalance) recs.push(mk("rebalance", r));
  for (const r of risk) recs.push(mk(r.kind === "cashDrag" ? "cashDrag" : "risk", r));
  for (const d of dca) if (d.due) recs.push(mk("dca", d));
  return recs;
}
