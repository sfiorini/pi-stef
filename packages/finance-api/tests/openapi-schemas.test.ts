import { describe, it, expect } from "vitest";
import {
  errorResponse,
  okEnvelope,
  holdingSchema,
  accountSchema,
  goalSchema,
  suggestionSchema,
  priceRowSchema,
  driftRowSchema,
  healthResponse,
  holdingsResponse,
  netWorthResponse,
  allocationResponse,
  driftResponse,
  historyResponse,
  goalsListResponse,
  suggestionsListResponse,
} from "../src/server/openapi-schemas";
import { z } from "@hono/zod-openapi";

describe("openapi-schemas", () => {
  describe("envelope schemas", () => {
    it("errorResponse accepts valid and rejects invalid", () => {
      expect(errorResponse.parse({ ok: false, error: { code: "bad_request", message: "x" } })).toBeTruthy();
      expect(() => errorResponse.parse({ ok: true })).toThrow();
    });

    it("okEnvelope wraps a data schema", () => {
      const schema = okEnvelope(z.object({ foo: z.string() }));
      expect(schema.parse({ ok: true, data: { foo: "bar" } })).toBeTruthy();
      expect(() => schema.parse({ ok: false, data: { foo: "bar" } })).toThrow();
    });
  });

  describe("domain schemas", () => {
    it("holdingSchema accepts valid and rejects invalid", () => {
      expect(holdingSchema.parse({
        account_id: "a1", symbol: "AAPL", quantity: 10,
        asset_class: "equity", as_of: 1,
      })).toBeTruthy();
      expect(() => holdingSchema.parse({ symbol: "AAPL" })).toThrow();
    });

    it("accountSchema accepts valid with holdings", () => {
      expect(accountSchema.parse({
        id: "a1", provider_id: "fidelity", kind: "brokerage", name: "Test",
        holdings: [],
      })).toBeTruthy();
    });

    it("goalSchema accepts valid", () => {
      expect(goalSchema.parse({
        id: "g1", name: "Growth",
        targetAllocation: { equity: 0.8 },
        riskLimits: {},
      })).toBeTruthy();
    });

    it("suggestionSchema accepts valid", () => {
      expect(suggestionSchema.parse({
        id: "s1", created_at: 1, market_session: "intraday",
        kind: "rebalance", payload: {}, status: "pending",
      })).toBeTruthy();
    });

    it("priceRowSchema accepts valid", () => {
      expect(priceRowSchema.parse({ symbol: "AAPL", date: 1, close: 150, source: "stooq" })).toBeTruthy();
    });

    it("driftRowSchema accepts valid", () => {
      expect(driftRowSchema.parse({
        class: "equity", currentPct: 0.5, targetPct: 0.8, deltaPct: -0.3, value: 1000,
      })).toBeTruthy();
    });
  });

  describe("per-endpoint response schemas", () => {
    it("healthResponse accepts valid", () => {
      expect(healthResponse.parse({ ok: true, data: { status: "ok", uptimeS: 42 } })).toBeTruthy();
    });

    it("holdingsResponse accepts valid", () => {
      expect(holdingsResponse.parse({
        ok: true, data: { accounts: [] },
      })).toBeTruthy();
    });

    it("netWorthResponse accepts valid", () => {
      expect(netWorthResponse.parse({ ok: true, data: { netWorth: 1000, accountCount: 2 } })).toBeTruthy();
    });

    it("allocationResponse accepts valid", () => {
      expect(allocationResponse.parse({
        ok: true, data: { allocation: { equity: 0.5 }, totalValue: 1000 },
      })).toBeTruthy();
    });

    it("driftResponse accepts valid", () => {
      expect(driftResponse.parse({ ok: true, data: { drift: [] } })).toBeTruthy();
    });

    it("historyResponse accepts valid", () => {
      expect(historyResponse.parse({
        ok: true, data: { history: [{ symbol: "AAPL", date: 1, close: 150, source: "stooq" }] },
      })).toBeTruthy();
    });

    it("goalsListResponse accepts valid", () => {
      expect(goalsListResponse.parse({ ok: true, data: { goals: [] } })).toBeTruthy();
    });

    it("suggestionsListResponse accepts valid", () => {
      expect(suggestionsListResponse.parse({ ok: true, data: { suggestions: [] } })).toBeTruthy();
    });
  });
});
