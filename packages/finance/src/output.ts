// Format structured service JSON → agent-readable text

export function formatHoldings(data: { accounts: { id: string; name: string; total_value?: number; holdings: { symbol: string; quantity: number; asset_class: string; price?: number | null; market_value?: number; gain_loss?: number | null }[] }[] }): string {
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines: string[] = [];
  for (const account of data.accounts) {
    const total = account.total_value != null ? ` \u2014 $${fmt(account.total_value)}` : "";
    lines.push(`Account: ${account.name} (${account.id})${total}`);
    for (const h of account.holdings) {
      const mv = h.market_value != null ? ` ($${fmt(h.market_value)})` : "";
      const px = h.price != null ? ` @ $${h.price.toFixed(2)}` : "";
      const gl = h.gain_loss != null
        ? ` ${h.gain_loss >= 0 ? "+" : "-"}$${fmt(Math.abs(h.gain_loss))}`
        : "";
      lines.push(`  ${h.symbol}: ${h.quantity} shares (${h.asset_class})${px}${mv}${gl}`);
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
