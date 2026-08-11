import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/store/migrations";
import { clientAuthGate } from "../../src/server/auth";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Build a tiny Hono app with the auth gate mounted on /v1/*,
 * a stub /v1/models route (OpenAI-style 200), and a stub /v1/messages route (Anthropic-style 200).
 * /v1/health is mounted BEFORE the gate (public).
 */
function makeApp(db: Database.Database, envKeys: string[] = []) {
  const app = new Hono();

  // Public health route (mounted before gate)
  app.get("/v1/health", (c) => c.json({ ok: true }));

  // Auth gate on /v1/*
  app.use("/v1/*", clientAuthGate({ db, envKeys, log: makeLogger() as any }));

  // Stub OpenAI-style route
  app.get("/v1/models", (c) => c.json({ object: "list", data: [] }));

  // Stub Anthropic-style route
  app.post("/v1/messages", async (c) => c.json({ type: "message", id: "msg_1" }));

  return app;
}

describe("clientAuthGate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("allows valid Bearer token from api_keys table", async () => {
    db.prepare(
      "INSERT INTO api_keys (key, label, created_at) VALUES (?, ?, ?)",
    ).run("sk-table-key", "test", Date.now());

    const app = makeApp(db);
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-table-key" },
    });
    expect(res.status).toBe(200);
  });

  it("allows valid Bearer token from env keys", async () => {
    const app = makeApp(db, ["sk-env-key"]);
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-env-key" },
    });
    expect(res.status).toBe(200);
  });

  it("allows valid x-api-key header", async () => {
    db.prepare(
      "INSERT INTO api_keys (key, label, created_at) VALUES (?, ?, ?)",
    ).run("sk-xapi", "test", Date.now());

    const app = makeApp(db);
    const res = await app.request("/v1/models", {
      headers: { "x-api-key": "sk-xapi" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 OpenAI envelope on /v1/models when missing auth", async () => {
    const app = makeApp(db);
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBeDefined();
  });

  it("returns 401 OpenAI envelope on /v1/models for invalid key", async () => {
    const app = makeApp(db);
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-invalid" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 401 Anthropic envelope on /v1/messages when missing auth", async () => {
    const app = makeApp(db);
    const res = await app.request("/v1/messages", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 401 Anthropic envelope on /v1/messages for invalid key", async () => {
    const app = makeApp(db);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-invalid" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 401 for a revoked table key", async () => {
    db.prepare(
      "INSERT INTO api_keys (key, label, created_at, revoked_at) VALUES (?, ?, ?, ?)",
    ).run("sk-revoked", "revoked", Date.now(), Date.now());

    const app = makeApp(db);
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-revoked" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("/v1/health is not gated — returns 200 without auth", async () => {
    const app = makeApp(db);
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
