import { describe, it, expect, vi } from "vitest";
import { createCoinbaseAdapter } from "../src/ingest/direct/coinbase";

describe("coinbase adapter", () => {
  it("maps Coinbase accounts response to RawHolding[]", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      accounts: [{ uuid: "a1", currency: "BTC", available_balance: { value: "1.5", currency: "BTC" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createCoinbaseAdapter({ fetcher: fetcher as never });
    const session = await adapter.authenticate({ keyName: "k", privateKey: "s" });
    const holdings = await adapter.getHoldings(session, "ignored");
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ symbol: "BTC", quantity: 1.5, assetClass: "crypto" });
  });
});
