import { describe, it, expect } from "vitest";
import { createSnaptradeAdapter } from "../src/ingest/aggregator/snaptrade";
import type { Credentials } from "../src/ingest/contract";
import { openDb } from "../src/store/db";
import { runIngest, type AdapterRegistry } from "../src/ingest/registry";

describe("snaptrade adapter — identity & auth", () => {
  it("kind/providerId set correctly", () => {
    const a = createSnaptradeAdapter();
    expect(a.kind).toBe("brokerage");
    expect(a.providerId).toBe("snaptrade");
  });

  it("authenticate throws if any of the 4 required credentials is missing", async () => {
    const a = createSnaptradeAdapter();
    await expect(a.authenticate({})).rejects.toThrow(/snaptrade requires clientId/i);
    await expect(a.authenticate({ clientId: "c" })).rejects.toThrow(/consumerKey/i);
    await expect(a.authenticate({ clientId: "c", consumerKey: "k" })).rejects.toThrow(/userId/i);
    await expect(a.authenticate({ clientId: "c", consumerKey: "k", userId: "u" })).rejects.toThrow(/userSecret/i);
  });

  it("authenticate returns a session tagged with providerId when all creds present", async () => {
    const a = createSnaptradeAdapter({ createClient: () => ({}) as never });
    const s = await a.authenticate({ clientId: "c", consumerKey: "k", userId: "u", userSecret: "s" });
    expect(s.providerId).toBe("snaptrade");
    expect(s.creds?.userId).toBe("u");
  });
});

function fakeClient(responses: Record<string, unknown>) {
  const call = (key: string) => async () => ({ data: responses[key] });
  return {
    accountInformation: {
      listUserAccounts: call("accounts"),
      getUserAccountPositions: call("positions"),
      getAccountActivities: call("activities"),
      getUserAccountBalance: call("balances"),
      getUserAccountDetails: call("details"),
    },
  } as never;
}

const CREDS: Credentials = { clientId: "c", consumerKey: "k", userId: "u", userSecret: "s" };

describe("snaptrade adapter — mapping", () => {
  it("listAccounts maps id/name/maskLast4", async () => {
    const a = createSnaptradeAdapter({ createClient: () => fakeClient({ accounts: [
      { id: "acct-1", name: "Brokerage", number: "12345678", institution_name: "Fidelity" },
      { id: "acct-2", name: null, number: null, institution_name: "Vanguard" },
    ] }) });
    const s = await a.authenticate(CREDS);
    const accts = await a.listAccounts(s);
    expect(accts).toEqual([
      { providerAccountId: "acct-1", kind: "brokerage", name: "Brokerage", maskLast4: "5678", currency: "USD" },
      { providerAccountId: "acct-2", kind: "brokerage", name: "Vanguard", maskLast4: undefined, currency: "USD" },
    ]);
  });

  it("getHoldings maps ticker/units/avgCost and skips zero + short positions", async () => {
    const a = createSnaptradeAdapter({ createClient: () => fakeClient({ positions: [
      { symbol: { symbol: { symbol: "AAPL", raw_symbol: "AAPL" } }, units: 10, average_purchase_price: 150 },
      { symbol: { symbol: { symbol: "CASH" } }, units: 0, average_purchase_price: 1 },          // skipped (zero)
      { symbol: { symbol: { symbol: "SHORT" } }, units: -5, average_purchase_price: 20 },        // skipped (short)
      { symbol: { id: "FALLBACK" }, units: 2, average_purchase_price: null },                    // ticker fallback to id
    ] }) });
    const s = await a.authenticate(CREDS);
    const holdings = await a.getHoldings(s, "acct-1");
    expect(holdings).toEqual([
      { symbol: "AAPL", quantity: 10, avgCost: 150, assetClass: "equity", subclass: "us" },
      { symbol: "FALLBACK", quantity: 2, avgCost: undefined, assetClass: "equity", subclass: "us" },
    ]);
  });

  it("getTransactions paginates the .data.data envelope and maps fields; respects 'since'", async () => {
    const PAGE = 2; // small page size so pagination is observable without 1000+ fixtures
    let seenStart: string | undefined;
    let calls = 0;
    const client = {
      accountInformation: {
        listUserAccounts: async () => ({ data: [] }),
        getUserAccountPositions: async () => ({ data: [] }),
        getUserAccountBalance: async () => ({ data: [] }),
        getUserAccountDetails: async () => ({ data: { balance: { total: { amount: 0 } } } }),
        getAccountActivities: async (params: any) => {
          calls++;
          seenStart = params.startDate;
          // page 1 fills the limit (2); page 2 is partial (1) → stops
          const page = params.offset === 0
            ? [{ id: "t1", trade_date: "2026-01-01", symbol: { symbol: "AAPL" }, units: 1, price: 10, type: "BUY", fee: 0.5 },
               { id: "t2", trade_date: "2026-01-02", symbol: { raw_symbol: "MSFT" }, units: 2, price: 20, type: "SELL", fee: 1 }]
            : [{ id: "t3", trade_date: "2026-01-03", symbol: { symbol: null, raw_symbol: null }, units: null, price: null, type: "DIVIDEND", fee: null }];
          return { data: { data: page, pagination: {} } };
        },
      },
    } as never;
    const a = createSnaptradeAdapter({ createClient: () => client, activitiesPageSize: PAGE });
    const s = await a.authenticate(CREDS);
    const txns = await a.getTransactions(s, "acct-1", 1700000000000);
    expect(calls).toBe(2);
    expect(seenStart).toBe(new Date(1700000000000).toISOString().slice(0, 10));
    expect(txns).toHaveLength(3);
    expect(txns[0]).toMatchObject({ id: "t1", symbol: "AAPL", qty: 1, price: 10, type: "buy", fees: 0.5 });
    expect(txns[1]).toMatchObject({ id: "t2", symbol: "MSFT", type: "sell" });
    expect(txns[2].id).toBe("t3");
    expect(txns[2].symbol).toBeUndefined();
    expect(txns[2].qty).toBeUndefined();
    expect(txns[2]).toMatchObject({ type: "dividend", fees: 0 });
  });

  it("getBalances picks USD cash and reads total amount from account details", async () => {
    const client = fakeClient({
      balances: [{ currency: { code: "CAD" }, cash: 9 }, { currency: { code: "USD" }, cash: 123.45 }],
      details: { balance: { total: { amount: 5250 } } },
    });
    const a = createSnaptradeAdapter({ createClient: () => client });
    const s = await a.authenticate(CREDS);
    const b = await a.getBalances(s, "acct-1");
    expect(b.cash).toBe(123.45);
    expect(b.marketValue).toBe(5250);
    expect(typeof b.asOf).toBe("number");
  });
});

describe("snaptrade adapter — ingest integration", () => {
  it("flows through runIngest into SQLite (holdings, transactions, balances, watermark)", async () => {
    const db = openDb(":memory:");
    const client = fakeClient({
      accounts: [{ id: "acct-1", name: "Brokerage", number: "1", institution_name: "Fidelity" }],
      positions: [{ symbol: { symbol: { symbol: "AAPL" } }, units: 10, average_purchase_price: 150 }],
      activities: { data: [{ id: "t1", trade_date: "2026-01-01", symbol: { symbol: "AAPL" }, units: 1, price: 10, type: "BUY", fee: 0 }], pagination: {} },
      balances: [{ currency: { code: "USD" }, cash: 200 }],
      details: { balance: { total: { amount: 1700 } } },
    });
    const registry: AdapterRegistry = new Map([["snaptrade", createSnaptradeAdapter({ createClient: () => client }) as never]]);
    const res = await runIngest(db, registry, { snaptrade: { ...CREDS } });
    expect(res.accounts).toBe(1);
    expect(res.holdings).toBe(1);
    expect(res.transactions).toBe(1);
    const h = db.prepare("SELECT * FROM holdings WHERE account_id=?").get("snaptrade:acct-1") as { symbol: string; quantity: number };
    expect(h.symbol).toBe("AAPL");
    expect(h.quantity).toBe(10);
    const t = db.prepare("SELECT * FROM transactions WHERE account_id=?").get("snaptrade:acct-1") as { type: string };
    expect(t.type).toBe("buy");
    const b = db.prepare("SELECT * FROM balances WHERE account_id=?").get("snaptrade:acct-1") as { cash: number; market_value: number };
    expect(b.cash).toBe(200);
    expect(b.market_value).toBe(1700);
    const acct = db.prepare("SELECT last_txn_sync_at AS w FROM accounts WHERE id=?").get("snaptrade:acct-1") as { w: number };
    expect(typeof acct.w).toBe("number");
  });
});
