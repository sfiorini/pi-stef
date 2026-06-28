import { describe, it, expect } from "vitest";
import { computeRebalance } from "../src/quant/rebalance";

describe("computeRebalance", () => {
  it("emits buy/sell orders to reach target, with dollar amounts", () => {
    const plan = computeRebalance(
      [{ symbol: "AAPL", assetClass: "equity", quantity: 10, price: 100 }],
      { targetAllocation: { equity: 0.5, cash: 0.5 } },
      { cashAvailable: 0, minTradeDollars: 10 },
    );
    // total = 1000 (equity) + 0 (cash) = 1000
    // equity target = 500, current = 1000 → sell ~500
    const sell = plan.find((o) => o.side === "sell");
    expect(sell).toBeDefined();
    expect(sell!.dollars).toBeGreaterThan(0);
  });
});
