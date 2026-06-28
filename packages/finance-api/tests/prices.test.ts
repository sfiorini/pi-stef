import { describe, it, expect, vi } from "vitest";
import { fetchClose } from "../src/market/prices";

describe("fetchClose", () => {
  it("returns a numeric close from stooq CSV", async () => {
    const fetcher = vi.fn(async () => new Response("Date,Open,High,Low,Close,Volume\n20260316,1,2,0.5,1.9,100\n", { status: 200 }));
    const close = await fetchClose("AAPL", { fetcher: fetcher as never, feed: "stooq" });
    expect(close).toBe(1.9);
  });
  it("crypto symbol uses Coinbase ticker", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ price: "65000" }), { status: 200, headers: { "content-type": "application/json" } }));
    const close = await fetchClose("CRYPTO:BTC", { fetcher: fetcher as never });
    expect(close).toBe(65000);
    expect((fetcher.mock.calls[0] as string[])[0]).toContain("coinbase.com");
  });
});
