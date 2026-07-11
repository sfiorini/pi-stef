import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";
import { upsertAccount, upsertHolding } from "../src/store/repo";

const token = "test-token-123";

describe("drift + history routes", () => {
  describe("GET /v1/drift", () => {
    it("returns 200 + ok:true with valid token", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/v1/drift", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.drift).toBeDefined();
    });
  });

  describe("GET /v1/history", () => {
    it("returns 200 + ok:true with valid symbol", async () => {
      const db = openDb(":memory:");
      upsertAccount(db, { id: "a1", provider_id: "test", kind: "brokerage", name: "Test", currency: "USD" });
      upsertHolding(db, { account_id: "a1", symbol: "AAPL", quantity: 10, asset_class: "equity", as_of: 1 });
      // Insert a price row
      db.prepare("INSERT INTO prices (symbol, date, close, source) VALUES (?, ?, ?, ?)").run("AAPL", 1, 150, "stooq");

      const app = createApp({ db, token });
      const res = await app.request("/v1/history?symbol=AAPL", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.history).toHaveLength(1);
    });

    it("returns 400 when symbol is missing", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/v1/history", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
