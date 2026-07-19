import { describe, it, expect, vi } from "vitest";
import { createSimplefinAdapter } from "../src/ingest/aggregator/simplefin";
import type { Credentials } from "../src/ingest/contract";
import { openDb } from "../src/store/db";
import { runIngest, type AdapterRegistry } from "../src/ingest/registry";

const CREDS_SETUP: Credentials = { setupToken: "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9kZW1v" };
const CREDS_ACCESS: Credentials = { accessUrl: "https://demo:secret@beta-bridge.simplefin.org/simplefin" };

const ACCOUNTS_RESPONSE = {
  errlist: [],
  accounts: [
    { id: "acc-1", name: "Checking", conn_id: "con-1", currency: "USD", balance: "1234.56", "available-balance": "1200.00", "balance-date": 1700000000 },
    { id: "acc-2", name: "Savings", conn_id: "con-1", currency: "USD", balance: "5678.90", "balance-date": 1700000000 },
  ],
};

const TXN_RESPONSE = {
  errlist: [],
  accounts: [
    {
      id: "acc-1", name: "Checking", currency: "USD", balance: "100.00", "balance-date": 1700000000,
      transactions: [
        { id: "t1", posted: 1700000100, amount: "500.00", description: "Paycheck" },
        { id: "t2", posted: 1700000200, amount: "-50.00", description: "Groceries" },
        { id: "t3", posted: 1700000300, amount: "-12.34", description: "Pending txn", pending: true },
      ],
    },
    {
      id: "acc-2", name: "Savings", currency: "USD", balance: "200.00", "balance-date": 1700000000,
      transactions: [
        { id: "t4", posted: 1700000400, amount: "1000.00", description: "Transfer" },
      ],
    },
  ],
};

function mockFetcher(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

describe("simplefin adapter — identity & auth", () => {
  it("sets kind=banking and providerId=simplefin", () => {
    const a = createSimplefinAdapter();
    expect(a.kind).toBe("banking");
    expect(a.providerId).toBe("simplefin");
  });

  it("throws if neither setupToken nor accessUrl provided", async () => {
    const a = createSimplefinAdapter();
    await expect(a.authenticate({})).rejects.toThrow(/simplefin requires setupToken or accessUrl/i);
  });

  it("authenticates directly when accessUrl is present (no network call)", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const a = createSimplefinAdapter({ fetcher });
    const s = await a.authenticate(CREDS_ACCESS);
    expect(s.providerId).toBe("simplefin");
    expect(fetcher).not.toHaveBeenCalled();
    expect(s.resolvedCreds).toBeUndefined();
  });

  it("exchanges setupToken for accessUrl and sets resolvedCreds", async () => {
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response("https://user:pass@bridge.simplefin.org/simplefin", { status: 200 });
    }) as unknown as typeof fetch;
    const a = createSimplefinAdapter({ fetcher });
    const s = await a.authenticate(CREDS_SETUP);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.resolvedCreds).toEqual({ accessUrl: "https://user:pass@bridge.simplefin.org/simplefin" });
  });

  it("throws when setup token exchange fails (HTTP 403)", async () => {
    const fetcher = vi.fn(async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;
    const a = createSimplefinAdapter({ fetcher });
    await expect(a.authenticate(CREDS_SETUP)).rejects.toThrow(/setup token.*403/i);
  });

  it("throws when claim endpoint returns non-HTTPS URL", async () => {
    const fetcher = vi.fn(async () => new Response("http://insecure.example.com", { status: 200 })) as unknown as typeof fetch;
    const a = createSimplefinAdapter({ fetcher });
    await expect(a.authenticate(CREDS_SETUP)).rejects.toThrow(/unexpected response from claim/i);
  });
});

describe("simplefin adapter — listAccounts & getBalances", () => {
  it("listAccounts maps id/name/currency", async () => {
    const a = createSimplefinAdapter({ fetcher: mockFetcher(ACCOUNTS_RESPONSE) });
    const s = await a.authenticate(CREDS_ACCESS);
    const accts = await a.listAccounts(s);
    expect(accts).toEqual([
      { providerAccountId: "acc-1", kind: "banking", name: "Checking", currency: "USD" },
      { providerAccountId: "acc-2", kind: "banking", name: "Savings", currency: "USD" },
    ]);
  });

  it("getBalances returns cached balance (no second HTTP call)", async () => {
    const fetcher = mockFetcher(ACCOUNTS_RESPONSE);
    const a = createSimplefinAdapter({ fetcher });
    const s = await a.authenticate(CREDS_ACCESS);
    await a.listAccounts(s);
    const bal = await a.getBalances(s, "acc-1");
    expect(bal).toEqual({ cash: 1234.56, marketValue: 0, asOf: 1700000000000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("getBalances returns zeros for unknown account", async () => {
    const a = createSimplefinAdapter({ fetcher: mockFetcher(ACCOUNTS_RESPONSE) });
    const s = await a.authenticate(CREDS_ACCESS);
    await a.listAccounts(s);
    const bal = await a.getBalances(s, "nope");
    expect(bal.cash).toBe(0);
  });

  it("handles empty accounts array", async () => {
    const a = createSimplefinAdapter({ fetcher: mockFetcher({ errlist: [], accounts: [] }) });
    const s = await a.authenticate(CREDS_ACCESS);
    const accts = await a.listAccounts(s);
    expect(accts).toEqual([]);
  });
});

describe("simplefin adapter — getTransactions", () => {
  it("maps transactions with correct date (s→ms), type (credit/debit), and filters pending", async () => {
    const a = createSimplefinAdapter({ fetcher: mockFetcher(TXN_RESPONSE) });
    const s = await a.authenticate(CREDS_ACCESS);
    const txns = await a.getTransactions(s, "acc-1");
    expect(txns).toEqual([
      { id: "t1", date: 1700000100000, type: "credit", fees: 0 },
      { id: "t2", date: 1700000200000, type: "debit", fees: 0 },
      // t3 (pending) excluded
    ]);
  });

  it("caches full response — only 1 HTTP call for getTransactions across multiple accounts", async () => {
    const fetcher = mockFetcher(TXN_RESPONSE);
    const a = createSimplefinAdapter({ fetcher });
    const s = await a.authenticate(CREDS_ACCESS);
    await a.getTransactions(s, "acc-1");
    await a.getTransactions(s, "acc-2");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("passes start-date from since watermark (ms → s conversion)", async () => {
    const fetcher = vi.fn(async (_url: string | URL) => {
      expect(String(_url)).toContain("start-date=1700000000");
      return new Response(JSON.stringify(TXN_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const a = createSimplefinAdapter({ fetcher });
    const s = await a.authenticate(CREDS_ACCESS);
    await a.getTransactions(s, "acc-1", 1700000000000);
  });
});

describe("simplefin adapter — error handling", () => {
  it("throws on gen.auth error in errlist", async () => {
    const response = { errlist: [{ code: "gen.auth", msg: "Authentication failed" }], accounts: [] };
    const a = createSimplefinAdapter({ fetcher: mockFetcher(response) });
    const s = await a.authenticate(CREDS_ACCESS);
    await expect(a.listAccounts(s)).rejects.toThrow(/Authentication failed/i);
  });

  it("does NOT throw on non-fatal connection errors (con.auth)", async () => {
    const response = {
      errlist: [{ code: "con.auth", msg: "Auth failed for one bank", conn_id: "con-1" }],
      accounts: [{ id: "acc-1", name: "OK Bank", currency: "USD", balance: "100", "balance-date": 1700000000 }],
    };
    const a = createSimplefinAdapter({ fetcher: mockFetcher(response) });
    const s = await a.authenticate(CREDS_ACCESS);
    const accts = await a.listAccounts(s);
    expect(accts).toHaveLength(1);
  });
});

describe("simplefin adapter — ingest integration", () => {
  it("flows through runIngest into SQLite", async () => {
    const db = openDb(":memory:");
    const response = {
      errlist: [],
      accounts: [{
        id: "bank-1", name: "Checking", currency: "USD",
        balance: "1234.56", "balance-date": 1700000000,
        transactions: [
          { id: "tx-1", posted: 1700000100, amount: "100.00", description: "Deposit" },
          { id: "tx-2", posted: 1700000200, amount: "-25.00", description: "ATM" },
        ],
      }],
    };
    const adapter = createSimplefinAdapter({ fetcher: mockFetcher(response) });
    const registry: AdapterRegistry = new Map([["simplefin", adapter]]);
    const result = await runIngest(db, registry, { simplefin: CREDS_ACCESS });
    expect(result.accounts).toBe(1);
    expect(result.transactions).toBe(2);
    expect(result.holdings).toBe(0);
    const acct = db.prepare("SELECT * FROM accounts WHERE id=?").get("simplefin:bank-1") as any;
    expect(acct).toBeTruthy();
    expect(acct.kind).toBe("banking");
    const bal = db.prepare("SELECT * FROM balances WHERE account_id=?").get("simplefin:bank-1") as any;
    expect(bal.cash).toBe(1234.56);
    const txns = db.prepare("SELECT * FROM transactions WHERE account_id=? ORDER BY date").all("simplefin:bank-1") as any[];
    expect(txns).toHaveLength(2);
    expect(txns[0].type).toBe("credit");
    expect(txns[1].type).toBe("debit");
  });

  it("propagates resolvedCredentials when setupToken is exchanged", async () => {
    const db = openDb(":memory:");
    const adapter = createSimplefinAdapter({
      fetcher: vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === "POST") return new Response("https://exchanged:token@bridge.simplefin.org/simplefin", { status: 200 });
        return new Response(JSON.stringify({ errlist: [], accounts: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const registry: AdapterRegistry = new Map([["simplefin", adapter]]);
    const result = await runIngest(db, registry, { simplefin: CREDS_SETUP });
    expect(result.resolvedCredentials).toEqual({
      simplefin: { accessUrl: "https://exchanged:token@bridge.simplefin.org/simplefin" },
    });
  });
});
