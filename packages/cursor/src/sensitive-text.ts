/**
 * Redaction helpers and API-key fingerprinting for the Cursor provider.
 * Prevents secret leakage in logs/errors and provides stable cache keys.
 */

import { createHash } from "node:crypto";

/** Redact known Cursor secret patterns from arbitrary text. */
export function redactCursorSecrets(text: string): string {
  if (!text) return text;
  return text
    // crsr_… tokens (>=20 chars after prefix)
    .replace(/crsr_[A-Za-z0-9_-]{20,}/g, "[redacted cursor key]")
    // JWT-like tokens (three dot-separated base64 segments, >= 40 chars total)
    .replace(
      /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "[redacted jwt]",
    )
    // key=… values (>=10 chars after key=)
    .replace(/\bkey=[A-Za-z0-9_./+=-]{10,}/g, "[redacted key=]");
}

/**
 * Deterministic short fingerprint of an API key.
 * Returns the first 16 hex chars of its SHA-256 hash.
 */
export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}
