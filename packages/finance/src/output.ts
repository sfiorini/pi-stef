// Format structured service JSON → agent-readable text
import type { CallResult } from "./client";

export function formatHoldings(data: { accounts: { id: string; name: string; holdings: { symbol: string; quantity: number; asset_class: string }[] }[] }): string {
  const lines: string[] = [];
  for (const account of data.accounts) {
    lines.push(`Account: ${account.name} (${account.id})`);
    for (const h of account.holdings) {
      lines.push(`  ${h.symbol}: ${h.quantity} shares (${h.asset_class})`);
    }
  }
  return lines.join("\n") || "No holdings found";
}

export function formatDrift(data: { drift: { class: string; currentPct: number; targetPct: number; deltaPct: number }[] }): string {
  const lines: string[] = ["Allocation Drift:"];
  for (const d of data.drift) {
    const status = d.deltaPct > 0.02 ? "⚠️ OVER" : d.deltaPct < -0.02 ? "⚠️ UNDER" : "✓";
    lines.push(`  ${d.class}: ${(d.currentPct * 100).toFixed(1)}% → target ${(d.targetPct * 100).toFixed(1)}% (${status})`);
  }
  return lines.join("\n");
}

export function formatSuggestions(data: { suggestions: { id: string; kind: string; payload: unknown }[] }): string {
  if (data.suggestions.length === 0) return "No pending suggestions";
  const lines: string[] = ["Pending Suggestions:"];
  for (const s of data.suggestions) {
    lines.push(`  [${s.kind}] ${JSON.stringify(s.payload)}`);
  }
  return lines.join("\n");
}

export function formatGeneric(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null) {
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}
