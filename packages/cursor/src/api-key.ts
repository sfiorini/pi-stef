/**
 * API-key resolution for the Cursor provider.
 *
 * Three-source precedence:
 *  1. Stored `api_key` credential  (AuthStorage / readStoredCredential)
 *  2. `CURSOR_API_KEY` env var
 *  3. Injected fallback
 *
 * Also provides legacy OAuth credential detection for migration warnings.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Env-var name for the Cursor API key. */
export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

/**
 * Sentinel value registered as the pi provider `apiKey`.
 * Actual resolution happens at request time via `resolveCursorRuntimeApiKey`.
 */
export const CURSOR_API_KEY_CONFIG_VALUE = "pi-stef-cursor-api-key-placeholder";

/**
 * Normalise a raw key value.
 * Returns `undefined` for absent, blank, or sentinel values.
 */
export function resolveCursorApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === CURSOR_API_KEY_CONFIG_VALUE) return undefined;
  return trimmed;
}

/** Credential shape returned by `readStoredCredential`. */
interface StoredCredential {
  type: "api_key" | "oauth";
  key?: string;
}

/** Path to pi's auth.json (matches `readStoredCredential`'s default; consistent with model-cache). */
function authJsonPath(): string {
  // Overridable for tests (PI_CURSOR_AUTH_JSON_PATH); defaults to pi's auth.json.
  return process.env.PI_CURSOR_AUTH_JSON_PATH ?? join(homedir(), ".pi", "agent", "auth.json");
}

/** Read the cursor credential directly from auth.json (version-independent). */
function readCursorCredentialFromDisk(): StoredCredential | undefined {
  try {
    const data = JSON.parse(readFileSync(authJsonPath(), "utf-8")) as Record<string, unknown>;
    return (data.cursor ?? undefined) as StoredCredential | undefined;
  } catch {
    return undefined;
  }
}

/** Persist the cursor API key to auth.json (read-modify-write; preserves other providers). */
export function writeCursorApiKey(key: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(authJsonPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    // missing or corrupt auth.json — start fresh
  }
  data.cursor = { type: "api_key", key };
  mkdirSync(dirname(authJsonPath()), { recursive: true });
  writeFileSync(authJsonPath(), JSON.stringify(data, null, 2));
}

/** Default reader: reads the cursor credential from auth.json. */
async function defaultReadStoredCredential(): Promise<StoredCredential | undefined> {
  return readCursorCredentialFromDisk();
}

/** Options for `resolveCursorRuntimeApiKey`. */
export interface ResolveApiKeyOptions {
  /** Async reader for the stored credential (injectable for tests). */
  readStoredCredential?: () => Promise<StoredCredential | undefined>;
  /** Raw env value (pass `process.env[CURSOR_API_KEY_ENV_VAR]` at call site). */
  envApiKey?: string | undefined;
  /** Optional fallback value (e.g. from a CLI flag). */
  fallbackApiKey?: string | undefined;
}

/**
 * Resolve the Cursor API key from three sources, in precedence order:
 *   stored `api_key` cred → `CURSOR_API_KEY` env → fallback.
 *
 * Returns `undefined` if all sources are absent or invalid.
 * Propagates reader errors.
 *
 * When called without options, uses sensible defaults:
 *   - readStoredCredential: AuthStorage lookup
 *   - envApiKey: process.env.CURSOR_API_KEY
 *   - fallbackApiKey: none
 */
export async function resolveCursorRuntimeApiKey(
  opts?: ResolveApiKeyOptions,
): Promise<string | undefined> {
  const readStoredCredential = opts?.readStoredCredential ?? defaultReadStoredCredential;
  const envApiKey = opts?.envApiKey ?? process.env[CURSOR_API_KEY_ENV_VAR];
  const fallbackApiKey = opts?.fallbackApiKey;

  const stored = await readStoredCredential();
  if (stored?.type === "api_key" && stored.key) {
    const resolved = resolveCursorApiKey(stored.key);
    if (resolved) return resolved;
  }

  const envKey = resolveCursorApiKey(envApiKey);
  if (envKey) return envKey;

  const fallback = resolveCursorApiKey(fallbackApiKey);
  if (fallback) return fallback;

  return undefined;
}

/**
 * Detect whether a legacy OAuth credential exists in storage.
 * Returns `true` if the stored cursor credential is `type: "oauth"`.
 * Returns `false` if absent or already `api_key`.
 */
export async function detectLegacyOAuthCredential(
  readStoredCredential: () => Promise<StoredCredential | undefined> = defaultReadStoredCredential,
): Promise<boolean> {
  const stored = await readStoredCredential();
  return stored?.type === "oauth";
}
