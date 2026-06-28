import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { runIngest, type AdapterRegistry } from "../src/ingest/registry";

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
});
