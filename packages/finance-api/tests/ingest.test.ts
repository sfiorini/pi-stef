import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { runIngest, type AdapterRegistry } from "../src/ingest/registry";
import { upsertAccount } from "../src/store/repo";

function fakeAdapter(holdings: { symbol: string; quantity: number; assetClass: string }[]) {
  return {
    kind: "crypto" as const, providerId: "fake",
    authenticate: async () => ({ providerId: "fake" }),
    listAccounts: async () => [{ providerAccountId: "a1", kind: "crypto" as const, name: "Fake", currency: "USD" }],
    getHoldings: async () => holdings,
    getTransactions: async () => [],
    getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 1 }),
  };
}

describe("runIngest", () => {
  it("persists normalized holdings from a registry", async () => {
    const db = openDb(":memory:");
    const registry: AdapterRegistry = new Map([["fake", fakeAdapter([{ symbol: "eth", quantity: 5, assetClass: "crypto" }]) as never]]);
    const result = await runIngest(db, registry, { fake: {} });
    expect(result.accounts).toBe(1);
    expect(result.holdings).toBe(1);
    const row = db.prepare("SELECT symbol FROM holdings WHERE account_id=?").get("fake:a1") as { symbol: string };
    expect(row.symbol).toBe("CRYPTO:ETH");
  });

  it("marks account stale on adapter error without throwing", async () => {
    const db = openDb(":memory:");
    const bad = { ...fakeAdapter([]), getHoldings: async () => { throw new Error("boom"); } };
    const registry: AdapterRegistry = new Map([["bad", bad as never]]);
    const result = await runIngest(db, registry, { bad: {} });
    expect(result.errors).toBe(1);
    const a = db.prepare("SELECT stale_reason FROM accounts WHERE id=?").get("bad:a1") as { stale_reason: string };
    expect(a.stale_reason).toContain("boom");
  });

  it("persists transactions (incremental) and balances", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "demo:a1", provider_id: "demo", kind: "crypto", name: "Demo", currency: "USD" });
    let sinceSeen: number | undefined;
    const adapter = {
      kind: "crypto" as const, providerId: "demo",
      authenticate: async () => ({ providerId: "demo" }),
      listAccounts: async () => [{ providerAccountId: "a1", kind: "crypto" as const, name: "Demo", currency: "USD" }],
      getHoldings: async () => [],
      getTransactions: async (_s: unknown, _acct: string, since?: number) => { sinceSeen = since; return [
        { id: "tx-1", date: 5000, symbol: "BTC", qty: 0.5, price: 30000, type: "buy", fees: 1 },
      ]; },
      getBalances: async () => ({ cash: 123.45, marketValue: 9000, asOf: 7 }),
    };
    const registry: AdapterRegistry = new Map([["demo", adapter as never]]);
    const result = await runIngest(db, registry, { demo: {} });
    expect(result.transactions).toBe(1);
    // watermark was null → since arg should be undefined
    expect(sinceSeen).toBeUndefined();
    const txn = db.prepare("SELECT * FROM transactions WHERE account_id=?").get("demo:a1") as { id: string; fees: number };
    expect(txn.id).toBe("tx-1");
    expect(txn.fees).toBe(1);
    const bal = db.prepare("SELECT * FROM balances WHERE account_id=?").get("demo:a1") as { cash: number; market_value: number };
    expect(bal.cash).toBe(123.45);
    expect(bal.market_value).toBe(9000);
  });

  it("passes the stored watermark as the 'since' argument on subsequent syncs", async () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "demo:a1", provider_id: "demo", kind: "crypto", name: "Demo", currency: "USD" });
    // seed a watermark as if a prior sync happened
    db.prepare("UPDATE accounts SET last_txn_sync_at=? WHERE id=?").run(9999, "demo:a1");
    let sinceSeen: number | undefined = -1;
    const adapter = {
      kind: "crypto" as const, providerId: "demo",
      authenticate: async () => ({ providerId: "demo" }),
      listAccounts: async () => [{ providerAccountId: "a1", kind: "crypto" as const, name: "Demo", currency: "USD" }],
      getHoldings: async () => [],
      getTransactions: async (_s: unknown, _acct: string, since?: number) => { sinceSeen = since; return []; },
      getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 0 }),
    };
    const registry: AdapterRegistry = new Map([["demo", adapter as never]]);
    await runIngest(db, registry, { demo: {} });
    expect(sinceSeen).toBe(9999);
  });

  it("propagates resolvedCredentials from session.resolvedCreds", async () => {
    const db = openDb(":memory:");
    const adapter = {
      kind: "banking" as const, providerId: "fake-resolver",
      authenticate: async () => ({ providerId: "fake-resolver", resolvedCreds: { accessUrl: "https://resolved" } }),
      listAccounts: async () => [{ providerAccountId: "a1", kind: "banking" as const, name: "Fake", currency: "USD" }],
      getHoldings: async () => [],
      getTransactions: async () => [],
      getBalances: async () => ({ cash: 0, marketValue: 0, asOf: 1 }),
    };
    const registry: AdapterRegistry = new Map([["fake-resolver", adapter as never]]);
    const result = await runIngest(db, registry, { "fake-resolver": {} });
    expect(result.resolvedCredentials).toEqual({ "fake-resolver": { accessUrl: "https://resolved" } });
  });

  it("scopes to a subset of providers when opts.providers is set", async () => {
    const db = openDb(":memory:");
    let alphaRan = false;
    let betaRan = false;
    const alpha = { ...fakeAdapter([{ symbol: "a", quantity: 1, assetClass: "equity" }]), providerId: "alpha",
      listAccounts: async () => { alphaRan = true; return []; } };
    const beta = { ...fakeAdapter([{ symbol: "b", quantity: 1, assetClass: "equity" }]), providerId: "beta",
      listAccounts: async () => { betaRan = true; return []; } };
    const registry: AdapterRegistry = new Map([
      ["alpha", alpha as never],
      ["beta", beta as never],
    ]);
    const result = await runIngest(db, registry, { alpha: {}, beta: {} }, undefined, { providers: ["alpha"] });
    expect(alphaRan).toBe(true);
    expect(betaRan).toBe(false);
    expect(result.accounts).toBe(0);
  });
});
