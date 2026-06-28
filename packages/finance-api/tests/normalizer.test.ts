import { describe, it, expect } from "vitest";
import { normalizeHolding } from "../src/ingest/normalizer";

describe("normalizer", () => {
  it("canonicalizes symbol + rounds quantity, passes through lots", () => {
    const n = normalizeHolding({ providerId: "coinbase", accountId: "c1" }, { symbol: "btc", quantity: 1.23456789, assetClass: "crypto", lots: [{ openDate: 1, qty: 1.23456789, costBasis: 100 }] });
    expect(n.symbol).toBe("CRYPTO:BTC");
    expect(n.quantity).toBeCloseTo(1.234568, 6);
    expect(n.lots?.[0].qty).toBeCloseTo(1.234568, 6);
  });
  it("rejects negative quantity", () => {
    expect(() => normalizeHolding({ providerId: "x", accountId: "a" }, { symbol: "AAPL", quantity: -1, assetClass: "equity" })).toThrow();
  });
});
