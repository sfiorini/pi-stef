import { describe, it, expect } from "vitest";
import { parsePositionsCsv } from "../src/ingest/file/csv";

describe("parsePositionsCsv (Fidelity positions export)", () => {
  it("parses a Fidelity-style positions CSV into RawHolding[]", () => {
    const csv = [
      "Account,Symbol,Description,Quantity,Last Price",
      "Brokerage,AAPL,Apple Inc.,10,190.50",
      "Brokerage,FXAIX,Fidelity 500 Index,5.123,180.00",
    ].join("\n");
    const holdings = parsePositionsCsv(csv);
    expect(holdings).toHaveLength(2);
    expect(holdings[0]).toMatchObject({ symbol: "AAPL", quantity: 10, assetClass: "equity" });
    expect(holdings[1]).toMatchObject({ symbol: "FXAIX", quantity: 5.123, assetClass: "equity" });
  });

  it("handles quoted fields with commas and dollar signs", () => {
    const csv = [
      "Account,Symbol,Description,Quantity,Last Price,Current Value",
      'Brokerage,AAPL,Apple Inc.,10,"$190.50 ","$1,905.00 "',
    ].join("\n");
    const holdings = parsePositionsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
    expect(holdings[0].quantity).toBe(10);
    expect(holdings[0].price).toBe(190.50);
  });

  it("handles BOM in the header line", () => {
    const csv = "\uFEFFAccount,Symbol,Description,Quantity,Last Price\n" +
      "Brokerage,AAPL,Apple Inc.,10,190.50";
    const holdings = parsePositionsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
  });
});

describe("parsePositionsCsv (crypto)", () => {
  it("detects XXX/USD symbols as crypto and strips the /USD suffix", () => {
    const csv = [
      "Account,Symbol,Description,Quantity,Last Price,Average cost basis",
      'Crypto IRA,BTC/USD,BITCOIN,0.09090909,"$64,153.56 ","$109,964.80 "',
      'Crypto IRA,ETH/USD,ETHEREUM,1.1235955,"$1,812.50 ","$4,449.57 "',
    ].join("\n");
    const holdings = parsePositionsCsv(csv);
    expect(holdings).toHaveLength(2);
    expect(holdings[0]).toMatchObject({ symbol: "BTC", assetClass: "crypto", securityType: "crypto" });
    expect(holdings[0].price).toBe(64153.56);
    expect(holdings[0].avgCost).toBe(109964.80);
    expect(holdings[0].quantity).toBeCloseTo(0.09090909, 6);
    expect(holdings[1]).toMatchObject({ symbol: "ETH", assetClass: "crypto" });
  });

  it("skips USD cash rows (no quantity)", () => {
    const csv = [
      "Account,Symbol,Description,Quantity,Last Price,Current Value",
      'Crypto IRA,USD***,US DOLLARS,,,"$5.37 "',
      'Crypto IRA,BTC/USD,BITCOIN,0.5,"$64,000 ","$32,000 "',
    ].join("\n");
    const holdings = parsePositionsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("BTC");
  });
});
