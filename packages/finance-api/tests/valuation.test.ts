import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding, upsertBalance } from "../src/store/repo";
import { valueHolding, valueHoldings, computeUnbilledCash, computeNetWorth } from "../src/valuation/value";

function seedAccount(db: ReturnType<typeof openDb>, id = "acct-1") {
  upsertAccount(db, { id, provider_id: "snaptrade", kind: "brokerage", name: "Test", currency: "USD" });
}

describe("valueHolding — price priority chain", () => {
  it("uses prices table first (Stooq — most recent)", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    upsertHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", price: 180, as_of: 1 });
    db.prepare("INSERT INTO prices (symbol, date, close, source) VALUES (?, ?, ?, ?)").run("AAPL", 1, 200, "tick");
    const v = valueHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", price: 180, as_of: 1 });
    expect(v.price).toBe(200);
    expect(v.marketValue).toBe(2000);
  });

  it("falls back to provider-supplied price when no Stooq price", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    upsertHolding(db, { account_id: "acct-1", symbol: "FDGRX", quantity: 100, avg_cost: 200, asset_class: "equity", price: 250, as_of: 1 });
    const v = valueHolding(db, { account_id: "acct-1", symbol: "FDGRX", quantity: 100, avg_cost: 200, asset_class: "equity", price: 250, as_of: 1 });
    expect(v.price).toBe(250);
    expect(v.marketValue).toBe(25000);
  });

  it("falls back to avg_cost when no Stooq price and no provider price", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    upsertHolding(db, { account_id: "acct-1", symbol: "XYZ", quantity: 5, avg_cost: 50, asset_class: "equity", as_of: 1 });
    const v = valueHolding(db, { account_id: "acct-1", symbol: "XYZ", quantity: 5, avg_cost: 50, asset_class: "equity", as_of: 1 });
    expect(v.price).toBe(50);
    expect(v.marketValue).toBe(250);
  });

  it("returns 0 price when nothing is available", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    const v = valueHolding(db, { account_id: "acct-1", symbol: "UNK", quantity: 10, avg_cost: null, asset_class: "equity", as_of: 1 });
    expect(v.price).toBe(0);
    expect(v.marketValue).toBe(0);
  });

  it("respects explicit price: 0 (not treated as missing)", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    // provider price = 0 should NOT fall through to avg_cost
    const v = valueHolding(db, { account_id: "acct-1", symbol: "X", quantity: 10, avg_cost: 100, asset_class: "equity", price: 0, as_of: 1 });
    expect(v.price).toBe(0);
  });
});

describe("valueHoldings — multi-account", () => {
  it("values all holdings across all accounts", () => {
    const db = openDb(":memory:");
    seedAccount(db, "acct-1");
    seedAccount(db, "acct-2");
    upsertHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", price: 180, as_of: 1 });
    upsertHolding(db, { account_id: "acct-2", symbol: "MSFT", quantity: 5, avg_cost: 300, asset_class: "equity", price: 350, as_of: 1 });
    const valued = valueHoldings(db);
    expect(valued).toHaveLength(2);
    expect(valued.find(v => v.symbol === "AAPL")?.marketValue).toBe(1800);
    expect(valued.find(v => v.symbol === "MSFT")?.marketValue).toBe(1750);
  });

  it("filters to a single account when accountId provided", () => {
    const db = openDb(":memory:");
    seedAccount(db, "acct-1");
    seedAccount(db, "acct-2");
    upsertHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", as_of: 1 });
    upsertHolding(db, { account_id: "acct-2", symbol: "MSFT", quantity: 5, avg_cost: 300, asset_class: "equity", as_of: 1 });
    const valued = valueHoldings(db, "acct-1");
    expect(valued).toHaveLength(1);
    expect(valued[0].symbol).toBe("AAPL");
  });
});

describe("computeUnbilledCash — double-counting prevention", () => {
  it("returns 0 when account has no balance row (P3 guard)", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    expect(computeUnbilledCash(db, "acct-1")).toBe(0);
  });

  it("returns full balance.cash when no cash-equivalent holdings", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    upsertHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", as_of: 1 });
    upsertBalance(db, { account_id: "acct-1", cash: 5000, market_value: 6500, as_of: 1 });
    expect(computeUnbilledCash(db, "acct-1")).toBe(5000);
  });

  it("subtracts cash-equivalent holding value to prevent double-counting", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    // SPAXX is a money market fund classified as "cash", 5000 shares at $1
    upsertHolding(db, { account_id: "acct-1", symbol: "SPAXX", quantity: 5000, avg_cost: 1, asset_class: "cash", price: 1, as_of: 1 });
    upsertBalance(db, { account_id: "acct-1", cash: 5000, market_value: 5000, as_of: 1 });
    // balance.cash (5000) − cash position value (5000) = 0 unbilled cash
    expect(computeUnbilledCash(db, "acct-1")).toBe(0);
  });

  it("returns excess cash beyond cash-equivalent holdings", () => {
    const db = openDb(":memory:");
    seedAccount(db);
    upsertHolding(db, { account_id: "acct-1", symbol: "SPAXX", quantity: 3000, avg_cost: 1, asset_class: "cash", price: 1, as_of: 1 });
    upsertBalance(db, { account_id: "acct-1", cash: 5000, market_value: 5000, as_of: 1 });
    // balance.cash (5000) − cash position value (3000) = 2000 unbilled
    expect(computeUnbilledCash(db, "acct-1")).toBe(2000);
  });
});

describe("computeNetWorth — holdings + unbilled cash", () => {
  it("sums all holding values + unbilled cash across accounts", () => {
    const db = openDb(":memory:");
    seedAccount(db, "acct-1");
    seedAccount(db, "acct-2");

    // Account 1: equity holding + cash sweep position
    upsertHolding(db, { account_id: "acct-1", symbol: "AAPL", quantity: 10, avg_cost: 150, asset_class: "equity", price: 200, as_of: 1 });
    upsertHolding(db, { account_id: "acct-1", symbol: "SPAXX", quantity: 3000, avg_cost: 1, asset_class: "cash", price: 1, as_of: 1 });
    upsertBalance(db, { account_id: "acct-1", cash: 5000, market_value: 7000, as_of: 1 });
    // Account 2: equity holding, no cash sweep
    upsertHolding(db, { account_id: "acct-2", symbol: "MSFT", quantity: 5, avg_cost: 300, asset_class: "equity", price: 350, as_of: 1 });
    upsertBalance(db, { account_id: "acct-2", cash: 1000, market_value: 2750, as_of: 1 });

    const { netWorth, accountCount } = computeNetWorth(db);
    // acct-1: AAPL (2000) + SPAXX (3000) + unbilled cash (5000−3000=2000) = 7000
    // acct-2: MSFT (1750) + unbilled cash (1000−0=1000) = 2750
    expect(netWorth).toBe(9750);
    expect(accountCount).toBe(2);
  });
});
