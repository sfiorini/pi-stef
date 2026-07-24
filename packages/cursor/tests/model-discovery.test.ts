import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The module under test — will import from model-cache and model-fallback.generated
import { discoverModels } from "../src/model-discovery";
import type { ModelListItem } from "../src/model-cache";

const FAKE_MODELS: ModelListItem[] = [
  { id: "gpt-5.4", displayName: "GPT-5.4" },
  { id: "claude-4.6-sonnet", displayName: "Sonnet 4.6" },
];

const FAKE_API_KEY = "crsr_test-key-12345678";

describe("discoverModels", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PI_CURSOR_DISABLE_MODEL_CACHE;
  });

  it("returns fallback when no API key is available", async () => {
    const result = await discoverModels({
      resolveApiKey: async () => undefined,
    });

    expect(result.source).toBe("fallback");
    expect(result.items.length).toBeGreaterThan(0);
    // Fallback items should come from FALLBACK_MODEL_ITEMS
    expect(result.items[0]).toHaveProperty("id");
    expect(result.items[0]).toHaveProperty("name");
  });

  it("returns cached items on cache hit (matching fingerprint, within TTL)", async () => {
    // We need to mock the cache to return our fake items
    vi.doMock("../src/model-cache", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../src/model-cache")>();
      const { fingerprintApiKey } = await import("../src/sensitive-text");
      const fp = fingerprintApiKey(FAKE_API_KEY);
      return {
        ...orig,
        readCachedModelList: vi.fn().mockReturnValue({
          items: FAKE_MODELS,
          apiKeyFingerprint: fp,
          savedAt: Date.now(),
        }),
      };
    });

    const { discoverModels: freshDiscover } = await import("../src/model-discovery");

    const result = await freshDiscover({
      resolveApiKey: async () => FAKE_API_KEY,
    });

    expect(result.source).toBe("cache");
    expect(result.items).toEqual(FAKE_MODELS);
  });

  it("returns live models when SDK is available and writes cache", async () => {
    const writeCachedModelList = vi.fn();
    const readCachedModelList = vi.fn().mockReturnValue(null); // cache miss

    vi.doMock("../src/model-cache", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../src/model-cache")>();
      return {
        ...orig,
        readCachedModelList,
        writeCachedModelList,
      };
    });

    const fakeList = vi.fn().mockResolvedValue(FAKE_MODELS);
    const fakeSdk = {
      Cursor: { models: { list: fakeList } },
    };

    const { discoverModels: freshDiscover } = await import("../src/model-discovery");

    const result = await freshDiscover({
      resolveApiKey: async () => FAKE_API_KEY,
      loadSdk: async () => fakeSdk as never,
    });

    expect(result.source).toBe("live");
    expect(result.items).toEqual(FAKE_MODELS);
    expect(fakeList).toHaveBeenCalledWith({ apiKey: FAKE_API_KEY });
    expect(writeCachedModelList).toHaveBeenCalledTimes(1);
    // Check writeCachedModelList was called with the correct items and a fingerprint
    const [items, fingerprint] = writeCachedModelList.mock.calls[0];
    expect(items).toEqual(FAKE_MODELS);
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint.length).toBe(16);
  });

  it("falls back when live SDK throws", async () => {
    vi.doMock("../src/model-cache", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../src/model-cache")>();
      return {
        ...orig,
        readCachedModelList: vi.fn().mockReturnValue(null), // cache miss
      };
    });

    const fakeSdk = {
      Cursor: { models: { list: vi.fn().mockRejectedValue(new Error("network")) } },
    };

    const { discoverModels: freshDiscover } = await import("../src/model-discovery");

    const result = await freshDiscover({
      resolveApiKey: async () => FAKE_API_KEY,
      loadSdk: async () => fakeSdk as never,
    });

    // Should try stale cache (maxAgeMs: Infinity), which is also a miss, then fallback
    expect(result.source).toBe("fallback");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("returns stale cache when live throws but stale cache exists", async () => {
    const { fingerprintApiKey } = await import("../src/sensitive-text");
    const fp = fingerprintApiKey(FAKE_API_KEY);

    // First call (fresh) returns null, second call (stale) returns data
    let callCount = 0;
    vi.doMock("../src/model-cache", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../src/model-cache")>();
      return {
        ...orig,
        readCachedModelList: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return null; // fresh cache miss
          return { items: FAKE_MODELS, apiKeyFingerprint: fp, savedAt: Date.now() - 999_999 }; // stale hit
        }),
        writeCachedModelList: vi.fn(),
      };
    });

    const fakeSdk = {
      Cursor: { models: { list: vi.fn().mockRejectedValue(new Error("network")) } },
    };

    const { discoverModels: freshDiscover } = await import("../src/model-discovery");

    const result = await freshDiscover({
      resolveApiKey: async () => FAKE_API_KEY,
      loadSdk: async () => fakeSdk as never,
    });

    expect(result.source).toBe("cache");
    expect(result.items).toEqual(FAKE_MODELS);
  });
});
