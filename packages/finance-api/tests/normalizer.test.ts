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

  it("passes through price and securityType", () => {
    const n = normalizeHolding({ providerId: "snaptrade", accountId: "a" }, { symbol: "FDGRX", quantity: 10, assetClass: "equity", price: 250.5, securityType: "oef" });
    expect(n.price).toBe(250.5);
    expect(n.security_type).toBe("oef");
  });

  it("overrides assetClass to 'cash' when cashEquivalent is true", () => {
    const n = normalizeHolding({ providerId: "snaptrade", accountId: "a" }, { symbol: "FDRXX", quantity: 214.31, assetClass: "equity", cashEquivalent: true, price: 1, securityType: "oef" });
    expect(n.asset_class).toBe("cash");
    expect(n.price).toBe(1);
    expect(n.security_type).toBe("oef");
  });

  it("does not override assetClass when cashEquivalent is false or absent", () => {
    const n1 = normalizeHolding({ providerId: "snaptrade", accountId: "a" }, { symbol: "AAPL", quantity: 10, assetClass: "equity", cashEquivalent: false });
    expect(n1.asset_class).toBe("equity");
    const n2 = normalizeHolding({ providerId: "snaptrade", accountId: "a" }, { symbol: "AAPL", quantity: 10, assetClass: "fixed_income", securityType: "bnd" });
    expect(n2.asset_class).toBe("fixed_income");
  });
});
