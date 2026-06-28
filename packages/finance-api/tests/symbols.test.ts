import { describe, it, expect } from "vitest";
import { canonicalSymbol, isCrypto } from "../src/store/symbols";

describe("symbols", () => {
  it("maps crypto to CRYPTO: namespace", () => {
    expect(canonicalSymbol("BTC", "crypto")).toBe("CRYPTO:BTC");
  });
  it("uppercases equity tickers", () => {
    expect(canonicalSymbol("aapl", "equity")).toBe("AAPL");
  });
  it("recognizes crypto namespace", () => {
    expect(isCrypto("CRYPTO:ETH")).toBe(true);
    expect(isCrypto("AAPL")).toBe(false);
  });
});
