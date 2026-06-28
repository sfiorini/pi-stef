import { describe, it, expect, vi } from "vitest";
import { createFinanceClient, OP_METHOD } from "../src/client";

describe("finance client", () => {
  it("callOp sends GET for read ops and POST for write ops", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { test: true } }), { status: 200 }));
    global.fetch = fetcher as never;

    const client = createFinanceClient({ apiUrl: "http://localhost:7780", token: "test-token" });

    // GET operation
    await client.callOp("get_holdings");
    expect((fetcher.mock.calls[0] as unknown[])[1]).toHaveProperty("method", "GET");

    // POST operation
    await client.callOp("set_target", { id: "g1", name: "test" });
    expect((fetcher.mock.calls[1] as unknown[])[1]).toHaveProperty("method", "POST");
    expect(JSON.parse(((fetcher.mock.calls[1] as unknown[])[1] as { body: string }).body)).toEqual({ id: "g1", name: "test" });
  });

  it("callOp includes Authorization header", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));
    global.fetch = fetcher as never;

    const client = createFinanceClient({ apiUrl: "http://localhost:7780", token: "my-token" });
    await client.callOp("market_status");

    expect(((fetcher.mock.calls[0] as unknown[])[1] as { headers: { Authorization: string } }).headers.Authorization).toBe("Bearer my-token");
  });

  it("callOp throws on {ok:false}", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "Goal not found" } }), { status: 404 }));
    global.fetch = fetcher as never;

    const client = createFinanceClient({ apiUrl: "http://localhost:7780", token: "test" });
    await expect(client.callOp("list_goals")).rejects.toThrow("not_found: Goal not found");
  });

  it("callOp throws service_unavailable on network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("Connection refused"); }) as never;

    const client = createFinanceClient({ apiUrl: "http://localhost:7780", token: "test" });
    await expect(client.callOp("market_status")).rejects.toThrow("service_unavailable");
  });

  it("OP_METHOD maps all expected operations", () => {
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
});
