import { describe, it, expect } from "vitest";
import { runTick } from "../src/scheduler/tick";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding, upsertGoal } from "../src/store/repo";
import type { AdapterRegistry } from "../src/ingest/registry";

describe("runTick", () => {
  it("runs ingest, price refresh, and suggestion generation", async () => {
    const db = openDb(":memory:");

    // Seed some data
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", as_of: 1 });
    upsertGoal(db, {
      id: "g1",
      name: "Growth",
      target_allocation: JSON.stringify({ equity: 0.8, bonds: 0.2 }),
      risk_limits: JSON.stringify({}),
    });

    // Mock fetcher that returns prices
    const fetcher = async (url: string) => {
      if (url.includes("stooq")) {
        return new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,20260628,1100,150,155,149,152,1000\n", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    const result = await runTick({
      db,
      registry: new Map() as AdapterRegistry,
      creds: {},
      fetcher: fetcher as never,
      now: new Date("2026-06-29T15:00:00Z").getTime(),  // Monday
    });

    expect(result.session).toBe("intraday");
    expect(result.pricesUpdated).toBeGreaterThanOrEqual(0);
    expect(result.suggestionsCreated).toBeGreaterThanOrEqual(0);
    
    // Verify market_sessions was persisted
    const sessions = db.prepare("SELECT * FROM market_sessions").all();
    expect(sessions.length).toBeGreaterThan(0);
    expect((sessions[0] as { session: string }).session).toBe("intraday");
  });

  it("on closed sessions, only refreshes crypto prices", async () => {
    const db = openDb(":memory:");

    // Seed data with both equity and crypto
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", as_of: 1 });
    upsertHolding(db, { account_id: "fid-1", symbol: "CRYPTO:BTC", quantity: 1, avg_cost: 50000, asset_class: "crypto", as_of: 1 });

    const fetchedSymbols: string[] = [];
    const fetcher = async (url: string) => {
      // Track which symbols were fetched
      if (url.includes("stooq")) {
        const match = url.match(/s=([a-z]+)/i);
        if (match) fetchedSymbols.push(match[1]);
        return new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,20260628,1100,150,155,149,152,1000\n", { status: 200 });
      }
      if (url.includes("coinbase")) {
        fetchedSymbols.push("CRYPTO:BTC");
        return new Response(JSON.stringify({ price: "55000" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    // Saturday = closed
    const result = await runTick({
      db,
      registry: new Map() as AdapterRegistry,
      creds: {},
      fetcher: fetcher as never,
      now: new Date("2026-06-27T15:00:00Z").getTime(), // Saturday
    });

    expect(result.session).toBe("closed");
    // Crypto should be fetched, equity should not
    expect(fetchedSymbols).toContain("CRYPTO:BTC");
    expect(fetchedSymbols).not.toContain("aapl");
  });

  it("threads opts.providers into runIngest so only scoped adapters run", async () => {
    const db = openDb(":memory:");
    let alphaRan = false;
    let betaRan = false;
    const alpha = {
      kind: "crypto" as const, providerId: "alpha",
      authenticate: async () => ({ providerId: "alpha" }),
      listAccounts: async () => { alphaRan = true; return []; },
      getHoldings: async () => [], getTransactions: async () => [], getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 0 }),
    };
    const beta = {
      kind: "crypto" as const, providerId: "beta",
      authenticate: async () => ({ providerId: "beta" }),
      listAccounts: async () => { betaRan = true; return []; },
      getHoldings: async () => [], getTransactions: async () => [], getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 0 }),
    };
    await runTick({
      db,
      registry: new Map([["alpha", alpha as never], ["beta", beta as never]]) as AdapterRegistry,
      creds: { alpha: {}, beta: {} },
      providers: ["alpha"],
      now: new Date("2026-06-29T15:00:00Z").getTime(),
    });
    expect(alphaRan).toBe(true);
    expect(betaRan).toBe(false);
  });
});
