import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const collectionPath = join(__dirname, "..", "postman", "finance-api.postman_collection.json");
const envPath = join(__dirname, "..", "postman", "finance-api.postman_environment.json");

describe("Postman collection (S-403/S-404)", () => {
  const collection = JSON.parse(readFileSync(collectionPath, "utf8"));

  it("is a valid Postman Collection v2.1", () => {
    expect(collection.info.schema).toBe(
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    );
  });

  it("has collection-level Bearer auth", () => {
    expect(collection.auth.type).toBe("bearer");
    expect(collection.auth.bearer[0].value).toBe("{{token}}");
  });

  it("has base_url and token variables", () => {
    const keys = collection.variable.map((v: any) => v.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("token");
  });

  it("has 5 folders (System, Portfolio, Goals, Suggestions, Data)", () => {
    const folderNames = collection.item.map((i: any) => i.name);
    expect(folderNames).toContain("System");
    expect(folderNames).toContain("Portfolio");
    expect(folderNames).toContain("Goals");
    expect(folderNames).toContain("Suggestions");
    expect(folderNames).toContain("Data");
  });

  it("has all 14 endpoints", () => {
    function countRequests(items: any[]): number {
      let count = 0;
      for (const item of items) {
        if (item.item) count += countRequests(item.item);
        else count++;
      }
      return count;
    }
    expect(countRequests(collection.item)).toBe(14);
  });

  it("health endpoint has a test script", () => {
    function findHealth(items: any[]): any {
      for (const item of items) {
        if (item.item) {
          const r = findHealth(item.item);
          if (r) return r;
        }
        if (item.request?.url?.path?.includes("health")) return item;
      }
    }
    const health = findHealth(collection.item);
    expect(health?.event?.[0]?.script?.exec).toBeDefined();
    expect(health.event[0].script.exec.join("")).toContain("ok");
  });

  it("all request URLs use {{base_url}} (not {{baseUrl}} or absolute)", () => {
    function checkUrls(items: any[], bad: string[]) {
      for (const item of items) {
        if (item.item) checkUrls(item.item, bad);
        const host = item.request?.url?.host?.[0];
        if (host && host !== "{{base_url}}") bad.push(`${item.name}: host=${host}`);
        if (item.request?.url?.raw?.includes("{{baseUrl}}")) bad.push(`${item.name}: raw has {{baseUrl}}`);
      }
    }
    const bad: string[] = [];
    checkUrls(collection.item, bad);
    expect(bad, `URL issues: ${bad.join("; ")}`).toHaveLength(0);
  });

  it("no per-request auth overrides (collection-level auth applies)", () => {
    function checkAuth(items: any[], bad: string[]) {
      for (const item of items) {
        if (item.item) checkAuth(item.item, bad);
        if (item.request?.auth) bad.push(item.name);
      }
    }
    const bad: string[] = [];
    checkAuth(collection.item, bad);
    expect(bad, `Per-request auth found on: ${bad.join("; ")}`).toHaveLength(0);
  });
});

describe("Postman environment (S-403)", () => {
  const env = JSON.parse(readFileSync(envPath, "utf8"));

  it("has base_url and token values", () => {
    const keys = env.values.map((v: any) => v.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("token");
  });

  it("base_url defaults to localhost:7780", () => {
    const baseUrl = env.values.find((v: any) => v.key === "base_url");
    expect(baseUrl.value).toBe("http://127.0.0.1:7780");
  });
});
