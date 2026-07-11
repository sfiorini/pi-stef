import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";

describe("OpenAPI spec — POST paths (S-307)", () => {
  const token = "test-token-123";

  async function getSpec() {
    const db = openDb(":memory:");
    const app = createApp({ db, token });
    const res = await app.request("/openapi.json");
    return await res.json();
  }

  const expectedPostPaths: Array<{ path: string; tag: string }> = [
    { path: "/v1/goals", tag: "Goals" },
    { path: "/v1/suggestions/dismiss", tag: "Suggestions" },
    { path: "/v1/sync", tag: "Data" },
    { path: "/v1/import", tag: "Data" },
    { path: "/v1/export", tag: "Data" },
  ];

  for (const { path, tag } of expectedPostPaths) {
    it(`POST ${path} is in spec with tag "${tag}" and requestBody`, async () => {
      const spec = await getSpec();
      const operation = spec.paths[path]?.post;
      expect(operation, `POST ${path} missing from spec`).toBeDefined();
      expect(operation.tags).toContain(tag);
      expect(operation.requestBody, `${path} POST missing requestBody`).toBeDefined();
      expect(operation.requestBody.content?.["application/json"]?.schema, `${path} POST missing body schema`).toBeDefined();
      expect(operation.security, `${path} should require BearerAuth`).toEqual([{ BearerAuth: [] }]);
      expect(operation.responses["200"], `${path} missing 200 response`).toBeDefined();
    });
  }

  it("full spec has all 14 endpoints", async () => {
    const spec = await getSpec();
    const allPaths = Object.keys(spec.paths);
    // 12 route files = 12 unique paths (goals and suggestions each have GET+POST on same path, except dismiss)
    expect(allPaths).toContain("/v1/health");
    expect(allPaths).toContain("/v1/market-status");
    expect(allPaths).toContain("/v1/holdings");
    expect(allPaths).toContain("/v1/net-worth");
    expect(allPaths).toContain("/v1/allocation");
    expect(allPaths).toContain("/v1/drift");
    expect(allPaths).toContain("/v1/history");
    expect(allPaths).toContain("/v1/goals");
    expect(allPaths).toContain("/v1/suggestions");
    expect(allPaths).toContain("/v1/suggestions/dismiss");
    expect(allPaths).toContain("/v1/sync");
    expect(allPaths).toContain("/v1/import");
    expect(allPaths).toContain("/v1/export");
  });
});
