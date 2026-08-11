/**
 * OpenAI-compatible error envelope.
 * Single source of truth — server/envelopes.ts re-exports from here.
 */

import type { Context } from "hono";

export function openaiErrorType(status: number): string {
  switch (status) {
    case 400:
    case 404:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 429:
      return "rate_limit_error";
    case 500:
    case 503:
      return "server_error";
    default:
      return "api_error";
  }
}

export function openaiError(
  c: Context,
  status: number,
  message: string,
  opts?: { code?: string; param?: string },
): Response {
  return c.json(
    {
      error: {
        message,
        type: openaiErrorType(status),
        param: opts?.param ?? null,
        code: opts?.code ?? null,
      },
    },
    status as any,
  );
}
