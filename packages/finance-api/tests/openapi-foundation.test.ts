import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";

describe("OpenAPI foundation", () => {
  const token = "test-token-123";

  describe("GET /openapi.json", () => {
    it("returns 200 with valid OpenAPI 3.1 spec", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/openapi.json");
      expect(res.status).toBe(200);
      const spec = await res.json();
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info.title).toBe("finance-api");
      expect(spec.info.version).toBeTruthy();
    });

    it("includes BearerAuth security scheme", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/openapi.json");
      const spec = await res.json();
      expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
      expect(spec.components.securitySchemes.BearerAuth.type).toBe("http");
      expect(spec.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    });

    it("does NOT require auth (public endpoint)", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/openapi.json");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /docs (Swagger UI)", () => {
    it("returns 200", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/docs");
      expect(res.status).toBe(200);
    });

    it("returns HTML content", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/docs");
      const body = await res.text();
      expect(body).toMatch(/swagger/i);
    });

    it("does NOT require auth (public endpoint)", async () => {
      const db = openDb(":memory:");
      const app = createApp({ db, token });
      const res = await app.request("/docs");
      expect(res.status).toBe(200);
    });
  });
});
