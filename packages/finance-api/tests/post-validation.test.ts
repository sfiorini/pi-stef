import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";
import { openDb } from "../src/store/db";

const token = "test-token-123";

describe("POST validation error format (S-301)", () => {
  it("returns {ok:false, error:{code:'bad_request', message}} with 400 on invalid body", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });

    // POST /v1/import with missing filePath
    const res = await app.request("/v1/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBeTruthy();
  });

  it("POST /v1/suggestions/dismiss with missing id returns bad_request 400", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });

    const res = await app.request("/v1/suggestions/dismiss", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
  });

  it("POST /v1/sync with no body returns 200 (not 400) — empty body defaults to {}", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });

    const res = await app.request("/v1/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("POST /v1/export with invalid format returns 400", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, token });

    const res = await app.request("/v1/export", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ format: "invalid" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
  });
});
