import type { RawHolding } from "../contract";

/**
 * Parse a single CSV line that may contain quoted fields with embedded commas.
 * e.g. `BTC/USD,BITCOIN,"$64,153.56 "` → ["BTC/USD", "BITCOIN", "$64,153.56 "]
 */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cols.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

/** Strip currency formatting: "$64,153.56 " → 64153.56, "($4,164.66)" → -4164.66 */
function parseCurrency(val: string): number | undefined {
  if (!val.trim()) return undefined;
  const cleaned = val.replace(/[$,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePositionsCsv(csv: string): RawHolding[] {
  // Strip BOM if present
  const text = csv.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const symIdx = header.findIndex((h) => h === "symbol");
  const qtyIdx = header.findIndex((h) => h === "quantity" || h === "shares" || h === "qty");
  const priceIdx = header.findIndex((h) => h === "last price" || h === "price");
  const avgCostIdx = header.findIndex((h) => h === "average cost basis" || h === "cost basis");
  if (symIdx === -1 || qtyIdx === -1) throw new Error("CSV missing Symbol or Quantity column");

  const out: RawHolding[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawSymbol = (cols[symIdx] ?? "").trim();
    const qty = Number((cols[qtyIdx] ?? "").replace(/[^0-9.\-]/g, ""));
    if (!rawSymbol || !Number.isFinite(qty) || qty === 0) continue;

    const price = priceIdx >= 0 ? parseCurrency(cols[priceIdx] ?? "") : undefined;
    const avgCost = avgCostIdx >= 0 ? parseCurrency(cols[avgCostIdx] ?? "") : undefined;

    // Detect crypto symbols: "BTC/USD", "ETH/USD", etc.
    const cryptoMatch = rawSymbol.match(/^([A-Z]+)\/(USD|USDT|EUR|GBP)$/i);
    if (cryptoMatch) {
      out.push({
        symbol: cryptoMatch[1].toUpperCase(),
        quantity: Math.abs(qty),
        price,
        avgCost,
        assetClass: "crypto",
        securityType: "crypto",
      });
      continue;
    }

    out.push({
      symbol: rawSymbol.toUpperCase(),
      quantity: Math.abs(qty),
      price,
      avgCost: avgCost ?? price,
      assetClass: "equity",
      subclass: "us",
    });
  }
  return out;
}
