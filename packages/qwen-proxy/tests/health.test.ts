import { describe, it, expect } from "vitest";
import { createApp } from "../src/server/app";

describe("health", () => {
  it("GET /v1/health returns 200 with {status:'ok'}", async () => {
    const app = createApp();
    const res = await app.request("/v1/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
