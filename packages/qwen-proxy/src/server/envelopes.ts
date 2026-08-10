/**
 * Error envelopes for both OpenAI and Anthropic surfaces.
 *
 * OpenAI: single source of truth is adapters/openai/errors.ts (re-exported here).
 * Anthropic: inline (will move to adapters/anthropic/errors.ts in M3).
 */

import type { Context } from "hono";

// ── OpenAI — re-export from adapters/openai/errors.ts ──────────────────────

export { openaiErrorType, openaiError } from "../adapters/openai/errors";

// ── Anthropic error envelope ─────────────────────────────────────────────────

export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 500:
      return "api_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

export function anthropicError(
  c: Context,
  status: number,
  type?: string,
  message?: string,
): Response {
  return c.json(
    {
      type: "error",
      error: {
        type: type ?? anthropicErrorType(status),
        message: message ?? "An error occurred",
      },
    },
    status as any,
  );
}
