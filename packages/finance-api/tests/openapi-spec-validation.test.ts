import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";

describe("OpenAPI spec validation (S-407)", () => {
  const token = "test-token-123";

  async function getSpec() {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/openapi.json");
    return await res.json();
  }

  it("has valid info block", async () => {
    const spec = await getSpec();
    expect(spec.info.title).toBe("finance-api");
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.description).toBeTruthy();
  });

  it("has BearerAuth security scheme defined", async () => {
    const spec = await getSpec();
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.BearerAuth.type).toBe("http");
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
  });

  // All 14 endpoints with their expected methods
  const endpoints: Array<{ path: string; methods: string[] }> = [
    { path: "/v1/health", methods: ["get"] },
    { path: "/v1/market-status", methods: ["get"] },
    { path: "/v1/holdings", methods: ["get"] },
    { path: "/v1/net-worth", methods: ["get"] },
    { path: "/v1/allocation", methods: ["get"] },
    { path: "/v1/drift", methods: ["get"] },
    { path: "/v1/history", methods: ["get"] },
    { path: "/v1/goals", methods: ["get", "post"] },
    { path: "/v1/suggestions", methods: ["get"] },
    { path: "/v1/suggestions/dismiss", methods: ["post"] },
    { path: "/v1/sync", methods: ["post"] },
    { path: "/v1/import", methods: ["post"] },
    { path: "/v1/export", methods: ["post"] },
  ];

  for (const { path, methods } of endpoints) {
    it(`${path} has correct methods and response schemas`, async () => {
      const spec = await getSpec();
      const pathItem = spec.paths[path];
      expect(pathItem, `Path ${path} missing from spec`).toBeDefined();

      for (const method of methods) {
        const operation = pathItem[method];
        expect(operation, `${method.toUpperCase()} ${path} missing`).toBeDefined();
        expect(operation.tags, `${method.toUpperCase()} ${path} missing tags`).toBeDefined();
        expect(operation.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
        expect(operation.responses["200"], `${method.toUpperCase()} ${path} missing 200`).toBeDefined();
        expect(
          operation.responses["200"].content?.["application/json"]?.schema,
          `${method.toUpperCase()} ${path} 200 missing schema`,
        ).toBeDefined();

        // At least one 4xx response (health is public, skip)
        if (path !== "/v1/health") {
          const has4xx = Object.keys(operation.responses).some((code) => code.startsWith("4"));
          expect(has4xx, `${method.toUpperCase()} ${path} should have a 4xx response`).toBe(true);
        }
      }
    });
  }
});
