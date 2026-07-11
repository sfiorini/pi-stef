import { describe, it, expect } from "vitest";
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiSubApp } from "../src/server/openapi-helpers";

describe("createOpenApiSubApp", () => {
  it("returns Zod validation errors in the existing error envelope with 400", async () => {
    const testRoute = createRoute({
      method: "post",
      path: "/",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ filePath: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "ok",
          content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
        },
      },
    });

    const app = createOpenApiSubApp();
    app.openapi(testRoute, (c) => c.json({ ok: true as const }, 200));

    // Missing filePath → Zod validation error
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBeTruthy();
  });

  it("passes through valid requests to the handler", async () => {
    const testRoute = createRoute({
      method: "post",
      path: "/",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ name: z.string() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "ok",
          content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
        },
      },
    });

    const app = createOpenApiSubApp();
    app.openapi(testRoute, (c) => c.json({ ok: true as const }, 200));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
