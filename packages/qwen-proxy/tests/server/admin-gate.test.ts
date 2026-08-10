import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminGate } from "../../src/server/admin-gate";

function makeApp(adminKey: string | undefined) {
  const app = new Hono();
  app.use("/admin/*", adminGate({ adminKey }));
  app.get("/admin/*", (c) => c.text("OK"));
  return app;
}

describe("adminGate", () => {
  // ── D15: key unset → 404 ───────────────────────────────────────────────

  it("returns 404 when adminKey is undefined (D15)", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/admin/");
    expect(res.status).toBe(404);
  });

  it("returns 404 with no key headers when adminKey is undefined", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/admin/dashboard", {
      headers: { Authorization: "Bearer something" },
    });
    expect(res.status).toBe(404);
  });

  // ── key set, no key provided → 401 ─────────────────────────────────────

  it("returns 401 when adminKey is set but no key provided", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/");
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toBe("Unauthorized");
  });

  // ── Bearer auth ────────────────────────────────────────────────────────

  it("returns 200 for valid Authorization: Bearer header", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for wrong Bearer token", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  // ── x-api-key auth ─────────────────────────────────────────────────────

  it("returns 200 for valid x-api-key header", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: { "x-api-key": "secret" },
    });
    expect(res.status).toBe(200);
  });

  // ── Cookie auth ────────────────────────────────────────────────────────

  it("returns 200 for valid cookie admin_key", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: { Cookie: "admin_key=secret" },
    });
    expect(res.status).toBe(200);
  });

  // ── Query key auth + Set-Cookie ────────────────────────────────────────

  it("returns 200 + Set-Cookie for valid ?key= query param", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/?key=secret");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBe(
      "admin_key=secret; HttpOnly; SameSite=Strict; Path=/admin",
    );
  });

  it("returns 401 for wrong ?key= query param", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/?key=wrong");
    expect(res.status).toBe(401);
  });

  it("returns 401 for empty ?key= query param", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/?key=");
    expect(res.status).toBe(401);
  });

  // ── Precedence: Bearer > x-api-key > cookie > query ────────────────────

  it("Bearer takes precedence over x-api-key", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: {
        Authorization: "Bearer secret",
        "x-api-key": "wrong",
      },
    });
    expect(res.status).toBe(200);
  });

  it("x-api-key takes precedence over cookie", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: {
        "x-api-key": "secret",
        Cookie: "admin_key=wrong",
      },
    });
    expect(res.status).toBe(200);
  });

  it("cookie takes precedence over query", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/?key=wrong", {
      headers: { Cookie: "admin_key=secret" },
    });
    expect(res.status).toBe(200);
  });

  // ── No Set-Cookie when not using query key ─────────────────────────────

  it("does not set cookie when using Bearer auth", async () => {
    const app = makeApp("secret");
    const res = await app.request("/admin/", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("URL-encodes admin_key cookie value and round-trips via cookie auth (audit F3)", async () => {
    const specialKey = "abc;def ghi";
    const app = makeApp(specialKey);
    // First request: ?key= sets the cookie
    const res1 = await app.request(`/admin/?key=${encodeURIComponent(specialKey)}`);
    expect(res1.status).toBe(200);
    const setCookie = res1.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    // The cookie value must be percent-encoded
    expect(setCookie).toContain("admin_key=abc%3Bdef%20ghi");
    // Must not contain raw semicolon inside the value portion
    expect(setCookie).not.toMatch(/admin_key=abc;def/);

    // Second request: send the Set-Cookie value back as Cookie header
    const cookieValue = setCookie!.split(";")[0]; // "admin_key=abc%3Bdef%20ghi"
    const res2 = await app.request("/admin/", {
      headers: { Cookie: cookieValue },
    });
    expect(res2.status).toBe(200);
  });
});
