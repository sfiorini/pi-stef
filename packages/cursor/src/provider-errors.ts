/**
 * Classify Cursor SDK errors into pi's error taxonomy.
 * Uses the injectable `loadCursorSdk()` seam so tests can mock the SDK error classes.
 */

import { loadCursorSdk } from "./sdk-runtime.js";
import { redactCursorSecrets } from "./sensitive-text.js";

export interface ClassifiedError {
  reason: "aborted" | "auth" | "rate_limit" | "network" | "busy" | "error";
  message: string;
}

/**
 * Classify an error thrown by @cursor/sdk into pi's error taxonomy.
 * Scrubs secrets from the message before returning.
 */
export async function classifyCursorError(err: unknown): Promise<ClassifiedError> {
  // P1-b: check abort FIRST (before SDK instanceof checks) so real aborts
  // are classified as 'aborted' rather than falling through to 'error'.
  if (isAbortError(err)) {
    return {
      reason: "aborted",
      message: redactCursorSecrets(err instanceof Error ? err.message : String(err)),
    };
  }

  const sdk = await loadCursorSdk();

  let reason: ClassifiedError["reason"] = "error";
  let message: string;

  if (err instanceof Error) {
    if (err instanceof sdk.AuthenticationError) {
      reason = "auth";
    } else if (err instanceof sdk.RateLimitError) {
      reason = "rate_limit";
    } else if (err instanceof sdk.AgentBusyError) {
      reason = "busy";
    } else if (err instanceof sdk.NetworkError) {
      reason = "network";
    }
    message = err.message;
  } else {
    message = String(err);
  }

  return { reason, message: redactCursorSecrets(message) };
}

/**
 * Check whether an error is an abort/cancellation.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (/aborted/i.test(err.message)) return true;
  }
  return false;
}
