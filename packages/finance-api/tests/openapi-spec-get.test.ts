import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";

describe("OpenAPI spec — GET paths", () => {
  const token = "test-token-123";

  async function getSpec() {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/openapi.json");
    return await res.json();
  }

  const expectedGetPaths: Array<{ path: string; tag: string; requiresAuth: boolean }> = [
    { path: "/v1/health", tag: "System", requiresAuth: false },
    { path: "/v1/market-status", tag: "System", requiresAuth: true },
    { path: "/v1/holdings", tag: "Portfolio", requiresAuth: true },
    { path: "/v1/net-worth", tag: "Portfolio", requiresAuth: true },
    { path: "/v1/allocation", tag: "Portfolio", requiresAuth: true },
    { path: "/v1/drift", tag: "Portfolio", requiresAuth: true },
    { path: "/v1/history", tag: "Portfolio", requiresAuth: true },
    { path: "/v1/goals", tag: "Goals", requiresAuth: true },
    { path: "/v1/suggestions", tag: "Suggestions", requiresAuth: true },
  ];

  for (const { path, tag, requiresAuth } of expectedGetPaths) {
    it(`GET ${path} is in spec with tag "${tag}" and ${requiresAuth ? "BearerAuth" : "no auth"}`, async () => {
      const spec = await getSpec();
      const operation = spec.paths[path]?.get;
      expect(operation, `Path ${path} missing from spec`).toBeDefined();
      expect(operation.tags).toContain(tag);
      expect(operation.responses["200"], `${path} missing 200 response`).toBeDefined();
      expect(operation.responses["200"].content?.["application/json"]?.schema, `${path} 200 missing schema`).toBeDefined();

      if (requiresAuth) {
        expect(operation.security, `${path} should require BearerAuth`).toEqual([{ BearerAuth: [] }]);
      } else {
        expect(operation.security, `${path} should NOT have security`).toBeUndefined();
      }
    });
  }

  it("history GET documents symbol (required) and accountId (optional) query params", async () => {
    const spec = await getSpec();
    const params = spec.paths["/v1/history"].get.parameters;
    const symbolParam = params.find((p: any) => p.name === "symbol");
    const accountIdParam = params.find((p: any) => p.name === "accountId");
    expect(symbolParam?.required).toBe(true);
    expect(accountIdParam?.required).toBe(false);
  });
});
