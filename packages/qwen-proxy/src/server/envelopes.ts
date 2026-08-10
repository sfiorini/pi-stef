import type { Context } from "hono";

// ── OpenAI error envelope ────────────────────────────────────────────────────

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
