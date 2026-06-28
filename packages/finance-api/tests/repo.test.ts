import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding, listHoldings, markStale } from "../src/store/repo";

describe("repo", () => {
  it("upserts accounts + holdings and lists them", () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity Brokerage", mask_last4: "1234", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", subclass: "us", as_of: 1 });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 12, avg_cost: 151, asset_class: "equity", subclass: "us", as_of: 2 });
    const h = listHoldings(db, "fid-1");
    expect(h).toHaveLength(1);
    expect(h[0].quantity).toBe(12);
  });

  it("marks an account stale with a reason", () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "boa-1", provider_id: "boa", kind: "banking", name: "BoA Checking", currency: "USD" });
    markStale(db, "boa-1", 1000, "file not found");
    const a = db.prepare("SELECT stale_reason FROM accounts WHERE id=?").get("boa-1") as { stale_reason: string };
    expect(a.stale_reason).toBe("file not found");
  });
});
