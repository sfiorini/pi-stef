/**
 * Model discovery for the Cursor provider.
 *
 * Precedence (highest to lowest):
 *   1. Live `Cursor.models.list({apiKey})` → write cache
 *   2. Fresh cache (TTL not expired, matching fingerprint)
 *   3. Stale cache (maxAgeMs: Infinity — fingerprint matches)
 *   4. Bundled `FALLBACK_MODEL_ITEMS`
 *
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

  // Step 2: fresh cache (skip if cache disabled)
  if (!cursorModelCacheDisabled()) {
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
  } catch {
    // SDK error → fall through to stale cache / fallback
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

async function defaultResolveApiKey(): Promise<string | undefined> {
  const envKey = process.env.CURSOR_API_KEY?.trim();
  if (envKey) return envKey;

  // Try stored credential via dynamic import (peer dep not in-repo)
  try {
    const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
    const stored = AuthStorage.create().get("cursor") as
      | { type: "api_key" | "oauth"; key?: string }
      | undefined;
    if (stored?.type === "api_key" && stored.key) return stored.key;
  } catch {
    // peer dep unavailable — that's fine
  }

  return undefined;
}
