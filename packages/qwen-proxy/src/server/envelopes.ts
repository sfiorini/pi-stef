/**
 * Error envelopes for both OpenAI and Anthropic surfaces.
 *
 * OpenAI: single source of truth is adapters/openai/errors.ts (re-exported here).
 * Anthropic: single source of truth is adapters/anthropic/errors.ts (re-exported here).
 */

// ── OpenAI — re-export from adapters/openai/errors.ts ──────────────────────

export { openaiErrorType, openaiError } from "../adapters/openai/errors";

// ── Anthropic — re-export from adapters/anthropic/errors.ts ────────────────

export { anthropicErrorType, anthropicError } from "../adapters/anthropic/errors";
