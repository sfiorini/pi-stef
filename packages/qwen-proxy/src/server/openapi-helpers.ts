import { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Factory for OpenAPIHono sub-routers with the custom validation hook pre-configured.
 * Every route module uses this instead of `new Hono()`.
 *
 * The defaultHook transforms Zod validation errors into the existing
 * `{ ok: false, error: { code: "bad_request", message: "..." } }` envelope
 * with HTTP 400.
 */
export function createOpenApiSubApp(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues.map((i) => i.message).join("; ");
        return c.json(
          {
            ok: false as const,
            error: { code: "bad_request", message },
          },
          400,
        );
      }
      return;
    },
  });
}
