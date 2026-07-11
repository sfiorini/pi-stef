import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding } from "../src/store/repo";

describe("server", () => {
  const token = "test-token-123";
  
  it("GET /v1/health returns ok without auth", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  it("GET /v1/holdings requires auth", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/v1/holdings");
    expect(res.status).toBe(401);
  });

  it("GET /v1/holdings returns accounts with valid token", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, asset_class: "equity", as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/holdings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.accounts).toHaveLength(1);
    expect(body.data.accounts[0].holdings).toHaveLength(1);
  });

  it("GET /v1/holdings enriches with price, market_value, gain_loss, and account total_value", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", price: 200, security_type: "cs", as_of: 1 });
    upsertHolding(db, { account_id: "fid-1", symbol: "LOSER", quantity: 5, avg_cost: 100, asset_class: "equity", price: 50, as_of: 1 });
    upsertHolding(db, { account_id: "fid-1", symbol: "NOBASIS", quantity: 8, asset_class: "equity", price: 30, as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/holdings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const aapl = body.data.accounts[0].holdings.find((h: { symbol: string }) => h.symbol === "AAPL");
    expect(aapl.price).toBe(200);
    expect(aapl.market_value).toBe(2000);
    expect(aapl.gain_loss).toBe(500); // (200 - 150) * 10
    const loser = body.data.accounts[0].holdings.find((h: { symbol: string }) => h.symbol === "LOSER");
    expect(loser.gain_loss).toBe(-250); // (50 - 100) * 5
    const nobasis = body.data.accounts[0].holdings.find((h: { symbol: string }) => h.symbol === "NOBASIS");
    expect(nobasis.gain_loss).toBeNull(); // no avg_cost → null
  });

  it("GET /v1/holdings?accountId= filters to a single account", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "acct-a", provider_id: "p", kind: "brokerage", name: "A", currency: "USD" });
    upsertAccount(db, { id: "acct-b", provider_id: "p", kind: "brokerage", name: "B", currency: "USD" });
    upsertHolding(db, { account_id: "acct-a", symbol: "AAPL", quantity: 10, asset_class: "equity", price: 100, as_of: 1 });
    upsertHolding(db, { account_id: "acct-b", symbol: "MSFT", quantity: 5, asset_class: "equity", price: 200, as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/holdings?accountId=acct-a", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.data.accounts).toHaveLength(1);
    expect(body.data.accounts[0].id).toBe("acct-a");
  });

  it("GET /v1/holdings?symbol= filters to a single ticker across all accounts", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "acct-a", provider_id: "p", kind: "brokerage", name: "A", currency: "USD" });
    upsertAccount(db, { id: "acct-b", provider_id: "p", kind: "brokerage", name: "B", currency: "USD" });
    upsertHolding(db, { account_id: "acct-a", symbol: "AAPL", quantity: 10, asset_class: "equity", price: 100, as_of: 1 });
    upsertHolding(db, { account_id: "acct-b", symbol: "AAPL", quantity: 5, asset_class: "equity", price: 100, as_of: 1 });
    upsertHolding(db, { account_id: "acct-b", symbol: "MSFT", quantity: 3, asset_class: "equity", price: 200, as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/holdings?symbol=AAPL", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    // Both accounts returned, but only AAPL holdings
    expect(body.data.accounts).toHaveLength(2);
    expect(body.data.accounts[0].holdings).toHaveLength(1);
    expect(body.data.accounts[0].holdings[0].symbol).toBe("AAPL");
    expect(body.data.accounts[1].holdings).toHaveLength(1);
    expect(body.data.accounts[1].holdings[0].symbol).toBe("AAPL");
  });

  it("POST /v1/goals upserts a goal and GET /v1/goals returns it", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    
    // Create goal
    const createRes = await app.request("/v1/goals", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "g1",
        name: "Growth",
        targetAllocation: { equity: 0.8, bonds: 0.2 },
        riskLimits: {},
      }),
    });
    expect(createRes.status).toBe(200);
    
    // List goals
    const listRes = await app.request("/v1/goals", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.data.goals).toHaveLength(1);
    expect(body.data.goals[0].name).toBe("Growth");
  });

  it("GET /v1/market-status returns session", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/v1/market-status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.session).toBeDefined();
  });

  it("GET /v1/net-worth returns net worth", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/net-worth", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.netWorth).toBe(1500); // 10 * 150
  });

  it("GET /v1/allocation returns allocation by asset class", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 100, asset_class: "equity", as_of: 1 });
    upsertHolding(db, { account_id: "fid-1", symbol: "BOND", quantity: 5, avg_cost: 200, asset_class: "bonds", as_of: 1 });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/allocation", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.allocation.equity).toBeCloseTo(0.5, 2); // 1000/2000
    expect(body.data.allocation.bonds).toBeCloseTo(0.5, 2); // 1000/2000
  });

  it("POST /v1/suggestions/dismiss requires id", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/v1/suggestions/dismiss", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/export with json format returns all tables", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    
    const app = createApp({ db, token });
    const res = await app.request("/v1/export", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ format: "json" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.accounts).toHaveLength(1);
  });

  it("POST /v1/sync uses request credentials when server has none", async () => {
    const db = openDb(":memory:");
    let seenCreds: Record<string, unknown> | undefined;
    const snaptrade = {
      kind: "brokerage" as const, providerId: "snaptrade",
      authenticate: async (c: any) => { seenCreds = c; return { providerId: "snaptrade", creds: c }; },
      listAccounts: async () => [],
      getHoldings: async () => [], getTransactions: async () => [], getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 0 }),
    };
    const app = createApp({
      db, token,
      registry: new Map([["snaptrade", snaptrade as never]]) as never,
      creds: {},   // server has NO snaptrade creds
    });
    const res = await app.request("/v1/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: ["snaptrade"],
        credentials: { snaptrade: { clientId: "from-request", consumerKey: "req-key" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(seenCreds).toMatchObject({ clientId: "from-request", consumerKey: "req-key" });
  });

  it("POST /v1/sync merges request credentials over server creds (request wins) without mutating server creds", async () => {
    const db = openDb(":memory:");
    let seenCreds: Record<string, unknown> | undefined;
    const snaptrade = {
      kind: "brokerage" as const, providerId: "snaptrade",
      authenticate: async (c: any) => { seenCreds = c; return { providerId: "snaptrade", creds: c }; },
      listAccounts: async () => [],
      getHoldings: async () => [], getTransactions: async () => [], getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 0 }),
    };
    const serverCreds = { snaptrade: { clientId: "from-server", consumerKey: "server-key" } };
    const app = createApp({
      db, token,
      registry: new Map([["snaptrade", snaptrade as never]]) as never,
      creds: serverCreds as never,
    });
    const res = await app.request("/v1/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: { snaptrade: { clientId: "from-request", consumerKey: "req-key" } },
      }),
    });
    expect(res.status).toBe(200);
    // Adapter received the REQUEST creds, not the server's.
    expect(seenCreds).toMatchObject({ clientId: "from-request", consumerKey: "req-key" });
    // Server's creds object was NOT mutated by the merge.
    expect(serverCreds.snaptrade).toMatchObject({ clientId: "from-server", consumerKey: "server-key" });
  });
});
