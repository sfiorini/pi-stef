import { describe, it, expect } from "vitest";
import { loadFinanceApiConfig } from "../src/config/load";

describe("loadFinanceApiConfig", () => {
  it("defaults to localhost:7780 and ~/.pi/sf/finance paths", async () => {
    const cfg = await loadFinanceApiConfig({}, "/tmp/home-x");
    expect(cfg.port).toBe(7780);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.dbPath).toBe("/tmp/home-x/.pi/sf/finance/finance.db");
    expect(cfg.secretsPath).toBe("/tmp/home-x/.pi/sf/finance/secrets.json");
    expect(cfg.dataFeed).toBe("stooq");
  });

  it("env SF_FINANCE_* override", async () => {
    const cfg = await loadFinanceApiConfig({ SF_FINANCE_PORT: "9999", SF_FINANCE_DB: "/x.db", SF_FINANCE_DATA_FEED: "yfinance" }, "/tmp/home-x");
    expect(cfg.port).toBe(9999);
    expect(cfg.dbPath).toBe("/x.db");
    expect(cfg.dataFeed).toBe("yfinance");
  });
});
