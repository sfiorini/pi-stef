import { describe, it, expect } from "vitest";
import { buildSuggestions } from "../src/quant/suggestions";

describe("buildSuggestions", () => {
  it("emits suggestion records from drift, rebalance, risk, dca", () => {
    const recs = buildSuggestions({
      drift: [{ class: "equity", currentPct: 1, targetPct: 0.5, deltaPct: 0.5, value: 1000 }],
      rebalance: [{ symbol: "AAPL", side: "sell", dollars: 500, estQty: 5 }],
      risk: [{ kind: "concentration", symbol: "AAPL", value: 1, limit: 0.25 }],
      dca: [{ due: true, amount: 2000, nextDueAt: 0 }],
      session: "intraday",
      now: 1,
    });
    expect(recs.length).toBeGreaterThanOrEqual(3);
    expect(recs.some((r) => r.kind === "drift")).toBe(true);
    expect(recs.some((r) => r.kind === "rebalance")).toBe(true);
    expect(recs.some((r) => r.kind === "dca")).toBe(true);
    expect(recs.some((r) => r.kind === "risk")).toBe(true);
  });
});
