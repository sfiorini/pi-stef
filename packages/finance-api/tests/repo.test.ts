import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding, listHoldings, markStale, upsertTransaction, listTransactions, upsertBalance, getBalance, getTxnWatermark, setTxnWatermark } from "../src/store/repo";

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

  it("clears stale flags on successful re-ingest", () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    markStale(db, "fid-1", 1000, "connection timeout");
    const before = db.prepare("SELECT stale_reason FROM accounts WHERE id=?").get("fid-1") as { stale_reason: string };
    expect(before.stale_reason).toBe("connection timeout");

    // Re-ingest succeeds
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    const after = db.prepare("SELECT stale_at, stale_reason FROM accounts WHERE id=?").get("fid-1") as { stale_at: number | null; stale_reason: string | null };
    expect(after.stale_at).toBeNull();
    expect(after.stale_reason).toBeNull();
  });
});

describe("transactions repo", () => {
  it("upserts and lists transactions by account, idempotent by id", () => {
    const db = openDb(":memory:");
    upsertTransaction(db, { id: "t1", account_id: "snaptrade:a1", date: 1000, symbol: "AAPL", qty: 1, price: 10, type: "buy", fees: 0 });
    // re-insert with updated price — should replace, not duplicate
    upsertTransaction(db, { id: "t1", account_id: "snaptrade:a1", date: 1000, symbol: "AAPL", qty: 1, price: 12, type: "buy", fees: 0 });
    upsertTransaction(db, { id: "t2", account_id: "snaptrade:a1", date: 2000, symbol: null, qty: null, price: null, type: "dividend", fees: 0 });
    const rows = listTransactions(db, "snaptrade:a1");
    expect(rows).toHaveLength(2);
    const t1 = rows.find(r => r.id === "t1")!;
    expect(t1.price).toBe(12);
    expect(rows.map(r => r.id)).toEqual(["t1", "t2"]);
  });
});

describe("balances repo", () => {
  it("upserts the latest balance per account (replace)", () => {
    const db = openDb(":memory:");
    upsertBalance(db, { account_id: "snaptrade:a1", cash: 100, market_value: 5000, as_of: 1 });
    upsertBalance(db, { account_id: "snaptrade:a1", cash: 250, market_value: 5250, as_of: 2 });
    const b = getBalance(db, "snaptrade:a1");
    expect(b?.cash).toBe(250);
    expect(b?.market_value).toBe(5250);
    expect(getBalance(db, "nope")).toBeUndefined();
  });
});

describe("txn watermark", () => {
  it("returns null before first sync and stores/returns the timestamp after", () => {
    const db = openDb(":memory:");
    upsertAccount(db, { id: "snaptrade:a1", provider_id: "snaptrade", kind: "brokerage", name: "Acct", currency: "USD" });
    expect(getTxnWatermark(db, "snaptrade:a1")).toBeNull();
    setTxnWatermark(db, "snaptrade:a1", 12345);
    expect(getTxnWatermark(db, "snaptrade:a1")).toBe(12345);
    expect(getTxnWatermark(db, "missing")).toBeNull();
  });
});
