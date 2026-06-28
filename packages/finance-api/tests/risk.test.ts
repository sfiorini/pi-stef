import { describe, it, expect } from "vitest";
import { checkRisk } from "../src/quant/risk";
import { acceptanceBand } from "../src/quant/limits";

describe("risk + limits", () => {
  it("flags concentration over limit", () => {
    const flags = checkRisk(
      [{ symbol: "AAPL", assetClass: "equity", quantity: 10, price: 100 }],
      { riskLimits: { maxSinglePosition: 0.25, maxCashDrag: 0.05 }, cashAvailable: 0 },
    );
    expect(flags.some((f) => f.kind === "concentration" && f.symbol === "AAPL")).toBe(true);
  });
  it("acceptanceBand returns buy-up-to and add-at-lower from rules", () => {
    const band = acceptanceBand({ currentPrice: 100, allowedSlippagePct: 0.5, lowerBandPct: 5 });
    expect(band.buyUpTo).toBeCloseTo(100.5, 2);
    expect(band.addAtLower).toBeCloseTo(95, 2);
  });
});
