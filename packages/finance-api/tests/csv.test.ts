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
});
