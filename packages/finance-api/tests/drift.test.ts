import { describe, it, expect } from "vitest";
import { computeDrift } from "../src/quant/drift";

describe("computeDrift", () => {
  it("computes current vs target pct and deltas", () => {
    const drift = computeDrift(
      [{ symbol: "AAPL", assetClass: "equity", quantity: 10, price: 100 }],
      { targetAllocation: { equity: 0.5, cash: 0.5 } },
    );
    // total value 1000; AAPL = 1000 → equity 100%, cash 0%
    const eq = drift.find((d) => d.class === "equity")!;
    expect(eq.currentPct).toBeCloseTo(1.0, 4);
    expect(eq.targetPct).toBeCloseTo(0.5, 4);
    expect(eq.deltaPct).toBeCloseTo(0.5, 4);
  });
});
