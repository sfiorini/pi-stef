import { describe, it, expect } from "vitest";
import { formatHoldings } from "../src/output";

describe("formatHoldings", () => {
  it("displays price, market value, and gain/loss per holding", () => {
    const result = formatHoldings({
      accounts: [{
        id: "acct-1",
        name: "Brokerage",
        total_value: 2500,
        holdings: [
          { symbol: "AAPL", quantity: 10, asset_class: "equity", price: 200, market_value: 2000, gain_loss: 500 },
          { symbol: "LOSER", quantity: 5, asset_class: "equity", price: 50, market_value: 250, gain_loss: -250 },
        ],
      }],
    });
    expect(result).toContain("AAPL");
    expect(result).toContain("$2,000.00");
    expect(result).toContain("+$500.00");
    expect(result).toContain("LOSER");
    expect(result).toContain("-$250.00");
    expect(result).toContain("$2,500.00"); // account total
  });

  it("omits gain/loss when avg_cost is null", () => {
    const result = formatHoldings({
      accounts: [{
        id: "acct-1",
        name: "Brokerage",
        total_value: 2000,
        holdings: [
          { symbol: "UNK", quantity: 10, asset_class: "equity", price: 200, market_value: 2000, gain_loss: null },
        ],
      }],
    });
    expect(result).toContain("$2,000.00");
    expect(result).not.toContain("+");
  });
});
