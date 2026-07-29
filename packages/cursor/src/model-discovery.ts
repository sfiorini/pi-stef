/**
 * Model discovery for the Cursor provider.
 *
 * Precedence (highest to lowest):
 *   1. Fresh cache (TTL not expired, matching fingerprint) — skipped when forceRefresh
 *   2. Live `Cursor.models.list({apiKey})` → write cache
 *   3. Stale cache (maxAgeMs: Infinity — fingerprint matches)
 *   4. Bundled `FALLBACK_MODEL_ITEMS`
 *
 * With `forceRefresh`, step 1 is skipped so the live call always runs (used by
 * `/cursor-refresh-models`).
 * If no API key is resolved, goes straight to fallback.
 * Never throws — callers always get a result.
 */

import { fingerprintApiKey } from "./sensitive-text.js";
import type { ModelListItem } from "./model-cache.js";
import {
  readCachedModelList,
  writeCachedModelList,
  cursorModelCacheDisabled,
} from "./model-cache.js";
import { resolveCursorRuntimeApiKey } from "./api-key.js";

// Dynamic import of @cursor/sdk — never static (peer dep not in-repo)
type CursorSdkModule = typeof import("@cursor/sdk");

// ── Lazy fallback items (avoid top-level import of generated file) ──

async function getFallbackItems(): Promise<ModelListItem[]> {
  const { FALLBACK_MODEL_ITEMS } = await import("./model-fallback.generated.js");
  return FALLBACK_MODEL_ITEMS as unknown as ModelListItem[];
}

// ── Options ──

export interface DiscoverModelsOptions {
  /** Injectable SDK loader (for tests). Default: dynamic import. */
  loadSdk?: () => Promise<CursorSdkModule>;
  /** Injectable API-key resolver (for tests). Default: env-only resolution. */
  resolveApiKey?: () => Promise<string | undefined>;
  /**
   * Bypass the fresh-cache check (step 1) and force a live SDK call.
   * Used by `/cursor-refresh-models`. The live result still overwrites the
   * cache; stale-cache fallback (step 3) remains in effect if live fails.
   */
  forceRefresh?: boolean;
  /** Called with the error when the live `Cursor.models.list` call throws
   *  (step 2). Use to surface the failure reason (e.g. debug logging). The
   *  discovery still falls through to stale cache / fallback; never throws. */
  onLiveError?: (err: unknown) => void;
}

export interface DiscoverModelsResult {
  items: ModelListItem[];
  source: "live" | "cache" | "fallback";
}

// ── Main entry ──

/**
 * Discover Cursor models with the full precedence chain.
 * Never throws — falls back to bundled models on any failure.
 */
export async function discoverModels(
  opts: DiscoverModelsOptions = {},
): Promise<DiscoverModelsResult> {
  const loadSdk = opts.loadSdk ?? (async () => import("@cursor/sdk"));
  const resolveApiKey = opts.resolveApiKey ?? defaultResolveApiKey;

  const fallbackItems = await getFallbackItems();

  // Step 1: resolve API key
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return { items: fallbackItems, source: "fallback" };
  }

  const fp = fingerprintApiKey(apiKey);

  // Step 2: fresh cache (skip if cache disabled, or forceRefresh requested)
  if (!opts.forceRefresh && !cursorModelCacheDisabled()) {
    const cached = readCachedModelList({ apiKeyFingerprint: fp });
    if (cached) {
      return { items: cached.items, source: "cache" };
    }
  }

  // Step 3: live SDK call
  try {
    const sdk = await loadSdk();
    const liveItems = await sdk.Cursor.models.list({ apiKey });

    if (liveItems.length > 0) {
      // Write cache (non-fatal if it fails)
      if (!cursorModelCacheDisabled()) {
        writeCachedModelList(liveItems, fp);
      }
      return { items: liveItems, source: "live" };
    }
    // Empty list → fall through to stale cache / fallback
  } catch (err) {
    // SDK error → surface the reason (if requested), then fall through to stale cache / fallback.
    // Guard the callback so a throwing logger can't break discoverModels' never-throws contract.
    try {
      opts.onLiveError?.(err);
    } catch {
      // ignore callback errors — discovery must still return a result
    }
  }

  // Step 4: stale cache (maxAgeMs: Infinity — any matching fingerprint)
  if (!cursorModelCacheDisabled()) {
    const stale = readCachedModelList({ apiKeyFingerprint: fp, maxAgeMs: Infinity });
    if (stale) {
      return { items: stale.items, source: "cache" };
    }
  }

  // Step 5: bundled fallback
  return { items: fallbackItems, source: "fallback" };
}

// ── Default API-key resolver ──

// P2-b: delegate to resolveCursorRuntimeApiKey so precedence is identical
// to streaming (stored → env → fallback).
async function defaultResolveApiKey(): Promise<string | undefined> {
  return resolveCursorRuntimeApiKey();
}
