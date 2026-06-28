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
});
