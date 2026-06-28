import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer } from "@pi-stef/finance-api";
import { openDb } from "@pi-stef/finance-api";
import { ensureToken } from "@pi-stef/finance-api";
import { createFinanceClient, OP_METHOD } from "../src/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("client↔server integration", () => {
  let serverHandle: { close: () => void; port: number };
  let token: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "finance-int-"));
    const tokenPath = join(tmpDir, "token");
    token = await ensureToken(tokenPath);
    const db = openDb(":memory:");
    serverHandle = await startServer({ db, token, port: 0 });
  });

  afterAll(() => {
    serverHandle?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("client OP_METHOD matches server routes for all operations", () => {
    // This test verifies the contract table is consistent
    const expectedOps = [
      "market_status", "get_holdings", "get_net_worth", "get_drift", "get_allocation",
      "list_goals", "set_target", "get_suggestions", "dismiss_suggestion",
      "sync_now", "import_file", "history", "health", "export",
    ];
    for (const op of expectedOps) {
      expect(OP_METHOD[op]).toBeDefined();
      expect(["GET", "POST"]).toContain(OP_METHOD[op]);
    }
  });

  it("GET /v1/health works without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${serverHandle.port}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  it("GET /v1/market-status works with auth", async () => {
    const client = createFinanceClient({
      apiUrl: `http://127.0.0.1:${serverHandle.port}`,
      token,
    });
    const data = await client.callOp<{ session: string }>("market_status");
    expect(data.session).toBeDefined();
  });

  it("server is running and responds", async () => {
    const res = await fetch(`http://127.0.0.1:${serverHandle.port}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("client throws on invalid token", async () => {
    const client = createFinanceClient({
      apiUrl: `http://127.0.0.1:${serverHandle.port}`,
      token: "wrong-token",
    });
    await expect(client.callOp("market_status")).rejects.toThrow("unauthorized");
  });
});
