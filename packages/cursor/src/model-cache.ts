/**
 * SDK-model-list cache for the Cursor provider.
 *
 * Stores the raw `ModelListItem[]` from `Cursor.models.list()` keyed on the
 * API-key fingerprint (first 16 hex chars of SHA-256).  TTL defaults to 24 h
 * and can be overridden with `PI_CURSOR_MODEL_CACHE_TTL_MS`.  Set
 * `PI_CURSOR_DISABLE_MODEL_CACHE=1` to bypass the cache entirely.
 *
 * The file is written with mode 0o600 to keep API-key fingerprints private.
 *
 * Local `ModelListItem` shape mirrors the SDK but is intentionally decoupled
 * so this module can be unit-tested without importing `@cursor/sdk`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
// ── Local model-list item shape (no @cursor/sdk dependency) ──

/** Minimal mirror of the SDK's ModelListItem — keeps unit tests fast. */
export interface ModelListItem {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: Array<{ id: string; value: string }>;
  variants?: unknown[];
}

// ── Cache file shape ──

export interface CachedModelList {
  items: ModelListItem[];
  apiKeyFingerprint: string;
  savedAt: number;
}

const CACHE_FILENAME = "cursor-sdk-model-list.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// ── Path ──

export function getCursorModelsCachePath(home: string = homedir()): string {
  return join(home, ".pi", "agent", CACHE_FILENAME);
}

// ── Disable flag ──

export function cursorModelCacheDisabled(): boolean {
  return process.env.PI_CURSOR_DISABLE_MODEL_CACHE === "1";
}

// ── TTL helper ──

function effectiveMaxAgeMs(override?: number): number {
  if (override !== undefined) return override;
  const envVal = process.env.PI_CURSOR_MODEL_CACHE_TTL_MS;
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

// ── Read ──

export interface ReadCachedModelListOptions {
  apiKeyFingerprint: string;
  home?: string;
  maxAgeMs?: number;
}

/**
 * Read the cached model list if it exists, is valid JSON, matches the given
 * API-key fingerprint, and has not expired.
 *
 * Returns `null` on any miss (missing file, corrupt JSON, fingerprint
 * mismatch, expired).
 */
export function readCachedModelList(opts: ReadCachedModelListOptions): CachedModelList | null {
  if (cursorModelCacheDisabled()) return null;

  let text: string;
  try {
    text = readFileSync(getCursorModelsCachePath(opts.home), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.items)) return null;
  if (typeof obj.apiKeyFingerprint !== "string") return null;
  if (typeof obj.savedAt !== "number") return null;

  // Fingerprint must match
  if (obj.apiKeyFingerprint !== opts.apiKeyFingerprint) return null;

  // TTL check
  const maxAge = effectiveMaxAgeMs(opts.maxAgeMs);
  if (Date.now() - obj.savedAt > maxAge) return null;

  return {
    items: obj.items as ModelListItem[],
    apiKeyFingerprint: obj.apiKeyFingerprint as string,
    savedAt: obj.savedAt as number,
  };
}

// ── Write ──

/**
 * Persist the model list to disk with mode 0o600.
 * Creates `~/.pi/agent/` recursively if needed.
 * Errors are swallowed (non-fatal — next startup falls back to bundled models).
 */
export function writeCachedModelList(
  items: ModelListItem[],
  apiKeyFingerprint: string,
  home: string = homedir(),
): void {
  try {
    const cachePath = getCursorModelsCachePath(home);
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CachedModelList = {
      items,
      apiKeyFingerprint,
      savedAt: Date.now(),
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    /* non-fatal */
  }
}
