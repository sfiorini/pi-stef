import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createCoinbaseAdapter } from "../src/ingest/direct/coinbase";
import type { FetchLike } from "../src/ingest/direct/coinbase";
import type { Credentials } from "../src/ingest/contract";
import { openDb } from "../src/store/db";
import { runIngest, type AdapterRegistry } from "../src/ingest/registry";
import { listTransactions, getBalance } from "../src/store/repo";

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

  it("breaks on has_next=true with empty cursor (single page, fetcher called once)", async () => {
    const fetcher = mockFetcher({ accounts: [{ uuid: "a1", currency: "BTC" }], has_next: true, cursor: "" });
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const accounts = await adapter.listAccounts(session);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerAccountId: "a1", currency: "BTC" });
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
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

describe("coinbase adapter — getTransactions (fills)", () => {
  it("single-page mapping: entry_id, BUY→credit, fees, date, symbol", async () => {
    const listResponse = {
      accounts: [{ uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "0.5" } }],
      has_next: false, cursor: "",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/orders/historical/fills")) {
        return new Response(JSON.stringify({
          fills: [{ entry_id: "e1", trade_time: "2024-01-15T10:30:00.000Z", side: "BUY", size: "0.5", price: "40000", commission: "1.25", product_id: "BTC-USD" }],
          cursor: "",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    const txns = await adapter.getTransactions(session, "a1");
    expect(txns).toEqual([{
      id: "e1",
      date: Date.parse("2024-01-15T10:30:00.000Z"),
      symbol: "BTC",
      qty: 0.5,
      price: 40000,
      fees: 1.25,
      type: "credit",
    }]);
  });

  it("since → start_sequence_timestamp + client-side filter (excludes older fill)", async () => {
    const SINCE = 1700000000000; // 2023-11-14T22:13:20.000Z
    const listResponse = {
      accounts: [{ uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "0.5" } }],
      has_next: false, cursor: "",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/orders/historical/fills")) {
        return new Response(JSON.stringify({
          fills: [
            // older fill — should be client-side filtered out
            { entry_id: "e-old", trade_time: "2023-10-01T00:00:00.000Z", side: "BUY", size: "1", price: "30000", commission: "0", product_id: "BTC-USD" },
            // newer fill — should be kept
            { entry_id: "e-new", trade_time: "2024-01-15T10:30:00.000Z", side: "BUY", size: "0.5", price: "40000", commission: "1", product_id: "BTC-USD" },
          ],
          cursor: "",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    const txns = await adapter.getTransactions(session, "a1", SINCE);
    // Only the newer fill should pass the client-side since filter
    expect(txns).toHaveLength(1);
    expect(txns[0].id).toBe("e-new");
    // Verify the fills request includes start_sequence_timestamp
    const fillsCall = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => (c[0] as string).includes("/orders/historical/fills"))!;
    const fillsUrl = (fillsCall as string[])[0] as string;
    expect(fillsUrl).toContain("start_sequence_timestamp");
    expect(fillsUrl).toContain("limit=100");
    const isoExpected = new Date(SINCE).toISOString();
    expect(fillsUrl).toContain(encodeURIComponent(isoExpected));
  });

  it("multi-page pagination (2 pages, second row SELL→debit)", async () => {
    const listResponse = {
      accounts: [{ uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } }],
      has_next: false, cursor: "",
    };
    const page1 = {
      fills: [{ entry_id: "e1", trade_time: "2024-01-15T10:30:00.000Z", side: "BUY", size: "1", price: "40000", commission: "2", product_id: "BTC-USD" }],
      cursor: "p2",
    };
    const page2 = {
      fills: [{ entry_id: "e2", trade_time: "2024-01-16T10:30:00.000Z", side: "SELL", size: "0.5", price: "41000", commission: "1", product_id: "BTC-USD" }],
      cursor: "",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/orders/historical/fills")) {
        // Determine which page based on cursor param
        if (url.includes("cursor=p2")) return new Response(JSON.stringify(page2), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(page1), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    const txns = await adapter.getTransactions(session, "a1");
    expect(txns).toHaveLength(2);
    expect(txns[0].type).toBe("credit"); // BUY
    expect(txns[1].type).toBe("debit");  // SELL
    // Two fills fetch calls (pages)
    const fillsCalls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => (c[0] as string).includes("/orders/historical/fills"));
    expect(fillsCalls).toHaveLength(2);
  });

  it("fiat account → [] (fetcher NOT called for fills)", async () => {
    const listResponse = {
      accounts: [{ uuid: "usd1", currency: "USD", type: "ACCOUNT_TYPE_FIAT", available_balance: { value: "500" } }],
      has_next: false, cursor: "",
    };
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    const txns = await adapter.getTransactions(session, "usd1");
    expect(txns).toEqual([]);
    // Only the listAccounts fetch should have been called, no fills fetch
    const fillsCalls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => (c[0] as string).includes("/orders/historical/fills"));
    expect(fillsCalls).toHaveLength(0);
  });

  it("proof_token_required no-throw (SCA returns [] without error)", async () => {
    const listResponse = {
      accounts: [{ uuid: "a1", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } }],
      has_next: false, cursor: "",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/orders/historical/fills")) {
        return new Response(JSON.stringify({ fills: [], cursor: "", proof_token_required: true }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);
    const txns = await adapter.getTransactions(session, "a1");
    expect(txns).toEqual([]);
  });
});

describe("coinbase adapter — runIngest integration", () => {
  it("flows through runIngest into SQLite: accounts, holdings, balances, transactions", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (url: string) => {
      // List accounts (no slash after /accounts means it's the list endpoint)
      if (url.includes("/accounts") && !url.includes("/accounts/")) {
        return new Response(JSON.stringify({
          accounts: [
            { uuid: "a1", name: "BTC Wallet", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } },
            { uuid: "usd1", name: "USD Wallet", currency: "USD", type: "ACCOUNT_TYPE_FIAT", available_balance: { value: "500" } },
          ],
          has_next: false, cursor: "",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Single account lookup
      if (url.includes("/accounts/a1")) {
        return new Response(JSON.stringify({
          account: { uuid: "a1", name: "BTC Wallet", currency: "BTC", type: "ACCOUNT_TYPE_CRYPTO", available_balance: { value: "1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/accounts/usd1")) {
        return new Response(JSON.stringify({
          account: { uuid: "usd1", name: "USD Wallet", currency: "USD", type: "ACCOUNT_TYPE_FIAT", available_balance: { value: "500" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Trade fills
      if (url.includes("/orders/historical/fills")) {
        return new Response(JSON.stringify({
          fills: [{
            entry_id: "e1", trade_time: "2024-01-15T10:30:00.000Z", side: "BUY",
            size: "0.5", price: "40000", commission: "1.25", product_id: "BTC-USD",
          }],
          cursor: "",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Market price
      if (url.includes("/market/products/BTC-USD")) {
        return new Response(JSON.stringify({ price: "64000" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;

    const adapter = createCoinbaseAdapter({ fetcher });
    const registry: AdapterRegistry = new Map([["coinbase", adapter as never]]);
    const result = await runIngest(db, registry, { coinbase: { keyName: KEY_NAME, privateKey: TEST_PRIVATE_KEY } });

    expect(result.accounts).toBe(2);
    expect(result.holdings).toBe(2);   // BTC (crypto) + USD (cashEquivalent)
    expect(result.transactions).toBe(1);
    expect(result.errors).toBe(0);

    // Accounts persisted
    const acct1 = db.prepare("SELECT * FROM accounts WHERE id=?").get("coinbase:a1") as { id: string; provider_id: string; kind: string };
    expect(acct1).toBeTruthy();
    expect(acct1.provider_id).toBe("coinbase");
    expect(acct1.kind).toBe("crypto");
    const acct2 = db.prepare("SELECT * FROM accounts WHERE id=?").get("coinbase:usd1") as { id: string };
    expect(acct2).toBeTruthy();

    // Holding persisted: CRYPTO:BTC with price
    const h = db.prepare("SELECT * FROM holdings WHERE account_id=?").get("coinbase:a1") as { symbol: string; quantity: number; price: number };
    expect(h).toBeTruthy();
    expect(h.symbol).toBe("CRYPTO:BTC");
    expect(h.quantity).toBe(1);
    expect(h.price).toBe(64000);

    // Balance persisted: fiat cash for usd1
    const bal = getBalance(db, "coinbase:usd1");
    expect(bal).toBeTruthy();
    expect(bal!.cash).toBe(500);

    // Transaction persisted
    const txns = listTransactions(db, "coinbase:a1");
    expect(txns).toHaveLength(1);
    expect(txns[0].id).toBe("e1");
    expect(txns[0].type).toBe("credit");
    expect(txns[0].symbol).toBe("BTC");
  });
});
