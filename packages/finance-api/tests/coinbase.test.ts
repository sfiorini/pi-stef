import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createCoinbaseAdapter } from "../src/ingest/direct/coinbase";
import type { FetchLike } from "../src/ingest/direct/coinbase";
import type { Credentials } from "../src/ingest/contract";

// Hermetic P-256 key for offline ES256 JWT signing. Generated per test-run.
const TEST_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY_NAME = "organizations/test-org/apiKeys/test-key";
const CREDS: Credentials = { keyName: KEY_NAME, privateKey: TEST_PRIVATE_KEY };

function mockFetcher(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200, headers: { "content-type": "application/json" } })) as unknown as FetchLike;
}

describe("coinbase adapter — identity & auth", () => {
  it("reports kind=crypto and providerId=coinbase", () => {
    const adapter = createCoinbaseAdapter();
    expect(adapter.kind).toBe("crypto");
    expect(adapter.providerId).toBe("coinbase");
  });

  it("throws when keyName or privateKey is missing", async () => {
    const adapter = createCoinbaseAdapter();
    await expect(adapter.authenticate({})).rejects.toThrow("coinbase requires keyName + privateKey");
    await expect(adapter.authenticate({ keyName: "k" })).rejects.toThrow("coinbase requires keyName + privateKey");
    await expect(adapter.authenticate({ privateKey: "p" })).rejects.toThrow("coinbase requires keyName + privateKey");
  });

  it("authenticate returns session with creds attached", async () => {
    const adapter = createCoinbaseAdapter();
    const session = await adapter.authenticate(CREDS);
    expect(session.providerId).toBe("coinbase");
    expect(session.creds).toEqual(CREDS);
  });
});

describe("coinbase adapter — listAccounts (JWT + pagination)", () => {
  it("sends Bearer ES256 JWT with correct header and payload claims", async () => {
    const fetcher = mockFetcher({ accounts: [{ uuid: "a1", currency: "BTC" }], has_next: false, cursor: "" });
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);

    const callArgs = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const authHeader = (callArgs[1].headers as Record<string, string>).Authorization;
    expect(authHeader).toMatch(/^Bearer /);
    const token = authHeader.replace("Bearer ", "");

    // No CB-ACCESS-* headers
    const headers = callArgs[1].headers as Record<string, string>;
    expect(Object.keys(headers).filter((k) => k.startsWith("CB-ACCESS"))).toHaveLength(0);

    // Decode and assert header claims
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(KEY_NAME);
    expect(header.typ).toBe("JWT");
    expect(header.nonce).toBeDefined();

    // Decode and assert payload claims
    const payload = decodeJwt(token);
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe(KEY_NAME);
    expect(payload.uris).toEqual(["GET api.coinbase.com/api/v3/brokerage/accounts"]);
  });

  it("paginates with cursor and concatenates results (2 fetch calls)", async () => {
    const page1 = { accounts: [{ uuid: "a1", name: "BTC Wallet", currency: "BTC" }], has_next: true, cursor: "page2cursor" };
    const page2 = { accounts: [{ uuid: "a2", name: "ETH Wallet", currency: "ETH" }], has_next: false, cursor: "" };
    let callCount = 0;
    const fetcher = vi.fn(async (_url: string) => {
      callCount++;
      const body = callCount === 1 ? page1 : page2;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;

    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const accounts = await adapter.listAccounts(session);

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ providerAccountId: "a1", kind: "crypto", name: "BTC Wallet", currency: "BTC" });
    expect(accounts[1]).toMatchObject({ providerAccountId: "a2", kind: "crypto", name: "ETH Wallet", currency: "ETH" });
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("throws on non-2xx response", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await expect(adapter.listAccounts(session)).rejects.toThrow("/accounts 500");
  });
});

describe("coinbase adapter — getHoldings", () => {
  it("BTC crypto holding (cache miss fetches /accounts/a1)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/a1")) {
        return new Response(JSON.stringify({
          account: { uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1.5" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const holdings = await adapter.getHoldings(session, "a1");
    expect(holdings).toEqual([
      { symbol: "BTC", quantity: 1.5, assetClass: "crypto", cashEquivalent: false },
    ]);
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/accounts/a1");
  });

  it("USDC cashEquivalent is true", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/u1")) {
        return new Response(JSON.stringify({
          account: { uuid: "u1", currency: "USDC", available_balance: { value: "100" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const holdings = await adapter.getHoldings(session, "u1");
    expect(holdings).toEqual([
      { symbol: "USDC", quantity: 100, assetClass: "crypto", cashEquivalent: true },
    ]);
  });

  it("cache hit avoids extra account fetch (price fetch still happens)", async () => {
    const listResponse = {
      accounts: [{ uuid: "a1", name: "BTC Wallet", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "2" } }],
      has_next: false, cursor: "",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/market/products/BTC-USD")) {
        return new Response(JSON.stringify({ price: "50000" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    (fetcher as unknown as ReturnType<typeof vi.fn>).mockClear();
    const holdings = await adapter.getHoldings(session, "a1");
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("BTC");
    // Only the price fetch should happen; no /accounts/a1 fetch (cache hit)
    const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("/market/products/BTC-USD");
    expect(calls[0][0]).not.toContain("/accounts/a1");
  });

  it("price attached for non-stablecoin (BTC 64000)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/a1")) {
        return new Response(JSON.stringify({
          account: { uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/market/products/BTC-USD")) {
        return new Response(JSON.stringify({ price: "64000" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const holdings = await adapter.getHoldings(session, "a1");
    expect(holdings).toEqual([
      { symbol: "BTC", quantity: 1, assetClass: "crypto", cashEquivalent: false, price: 64000 },
    ]);
  });

  it("price omitted on 404 (non-fatal)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/a1")) {
        return new Response(JSON.stringify({
          account: { uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/market/products/BTC-USD")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const holdings = await adapter.getHoldings(session, "a1");
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("BTC");
    expect(holdings[0]).not.toHaveProperty("price");
  });
});

describe("coinbase adapter — getBalances", () => {
  it("fiat USD cash=500.25 with injectable now", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/usd1")) {
        return new Response(JSON.stringify({
          account: { uuid: "usd1", currency: "USD", type: "ACCOUNT_TYPE_FIAT", available_balance: { value: "500.25" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher, now: () => 12345 });
    const session = await adapter.authenticate(CREDS);
    const balance = await adapter.getBalances(session, "usd1");
    expect(balance).toEqual({ cash: 500.25, marketValue: 0, asOf: 12345 });
  });

  it("crypto BTC cash=0", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/accounts/a1")) {
        return new Response(JSON.stringify({
          account: { uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1.5" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const balance = await adapter.getBalances(session, "a1");
    expect(balance).toEqual({ cash: 0, marketValue: 0, asOf: expect.any(Number) });
  });
});
