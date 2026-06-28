import type { RawHolding } from "../contract";

const EQUITY_HINTS = /^(FX|Fidelity|Vanguard|SW|VTI|SPY|AAPL|MSFT|GOOG|AMZN)/i; // crude; refined in 4.x if needed

export function parsePositionsCsv(csv: string): RawHolding[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const symIdx = header.findIndex((h) => h === "symbol");
  const qtyIdx = header.findIndex((h) => h === "quantity" || h === "shares" || h === "qty");
  const priceIdx = header.findIndex((h) => h === "last price" || h === "price");
  if (symIdx === -1 || qtyIdx === -1) throw new Error("CSV missing Symbol or Quantity column");

  const out: RawHolding[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const symbol = (cols[symIdx] ?? "").trim();
    const qty = Number((cols[qtyIdx] ?? "").replace(/[^0-9.\-]/g, ""));
    if (!symbol || !Number.isFinite(qty) || qty === 0) continue;
    const price = priceIdx >= 0 ? Number((cols[priceIdx] ?? "").replace(/[^0-9.\-]/g, "")) : undefined;
    out.push({
      symbol,
      quantity: Math.abs(qty),
      avgCost: Number.isFinite(price) ? price : undefined,
      assetClass: "equity", // file import defaults to equity; cash rows handled by OFX/txns
      subclass: EQUITY_HINTS.test(symbol) ? "us" : "us",
    });
  }
  return out;
}
