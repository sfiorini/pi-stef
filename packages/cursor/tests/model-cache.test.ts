import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// TDD: these imports will fail until we implement the new model-cache.ts
import {
  getCursorModelsCachePath,
  readCachedModelList,
  writeCachedModelList,
  cursorModelCacheDisabled,
} from "../src/model-cache";

import { fingerprintApiKey } from "../src/sensitive-text";

const SAMPLE_KEY = "crsr_test-abcdef123456";
const SAMPLE_FINGERPRINT = fingerprintApiKey(SAMPLE_KEY);

const SAMPLE_ITEMS = [
  { id: "gpt-5.4", displayName: "GPT-5.4", description: "A model" },
  { id: "claude-4.6-sonnet", displayName: "Sonnet 4.6" },
];

describe("getCursorModelsCachePath", () => {
  it("returns ~/.pi/agent/cursor-sdk-model-list.json", () => {
    expect(getCursorModelsCachePath("/home/u")).toBe(
      join("/home/u", ".pi", "agent", "cursor-sdk-model-list.json"),
    );
  });
});

describe("cursorModelCacheDisabled", () => {
  const origEnv = process.env.PI_CURSOR_DISABLE_MODEL_CACHE;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PI_CURSOR_DISABLE_MODEL_CACHE;
    else process.env.PI_CURSOR_DISABLE_MODEL_CACHE = origEnv;
  });

  it("returns false when env is unset", () => {
    delete process.env.PI_CURSOR_DISABLE_MODEL_CACHE;
    expect(cursorModelCacheDisabled()).toBe(false);
  });

  it("returns true when env is '1'", () => {
    process.env.PI_CURSOR_DISABLE_MODEL_CACHE = "1";
    expect(cursorModelCacheDisabled()).toBe(true);
  });
});

describe("readCachedModelList + writeCachedModelList round-trip", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cursor-cache-sdk-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("write then read returns the same items, fingerprint, and savedAt", () => {
    writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
    const cached = readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home });
    expect(cached).not.toBeNull();
    expect(cached!.items).toEqual(SAMPLE_ITEMS);
    expect(cached!.apiKeyFingerprint).toBe(SAMPLE_FINGERPRINT);
    expect(cached!.savedAt).toBeGreaterThan(0);
  });

  it("read returns null when the cache file is missing", () => {
    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home }),
    ).toBeNull();
  });

  it("read returns null for corrupt JSON", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(getCursorModelsCachePath(home), "{not json", "utf8");
    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home }),
    ).toBeNull();
  });

  it("read returns null when items is not an array", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getCursorModelsCachePath(home),
      JSON.stringify({ items: "nope", apiKeyFingerprint: SAMPLE_FINGERPRINT, savedAt: 1 }),
      "utf8",
    );
    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home }),
    ).toBeNull();
  });
});

describe("fingerprint match/mismatch", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cursor-cache-fp-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("read returns null when fingerprint does not match", () => {
    writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
    expect(
      readCachedModelList({ apiKeyFingerprint: "different-fingerprint", home }),
    ).toBeNull();
  });

  it("read returns data when fingerprint matches", () => {
    writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
    const cached = readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home });
    expect(cached).not.toBeNull();
    expect(cached!.items).toEqual(SAMPLE_ITEMS);
  });
});

describe("TTL expiry", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cursor-cache-ttl-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("read returns null when cache is older than maxAgeMs", () => {
    // Write cache with savedAt in the distant past
    const cachePath = getCursorModelsCachePath(home);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const payload = {
      items: SAMPLE_ITEMS,
      apiKeyFingerprint: SAMPLE_FINGERPRINT,
      savedAt: Date.now() - 100_000, // 100 seconds ago
    };
    writeFileSync(cachePath, JSON.stringify(payload), "utf8");

    // maxAgeMs=50s → expired
    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home, maxAgeMs: 50_000 }),
    ).toBeNull();
  });

  it("read returns data when cache is within maxAgeMs", () => {
    writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home, maxAgeMs: 60_000 }),
    ).not.toBeNull();
  });

  it("uses default 24h TTL when maxAgeMs is not specified", () => {
    // Write cache with savedAt 25h ago
    const cachePath = getCursorModelsCachePath(home);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const payload = {
      items: SAMPLE_ITEMS,
      apiKeyFingerprint: SAMPLE_FINGERPRINT,
      savedAt: Date.now() - 25 * 3600_000, // 25 hours ago
    };
    writeFileSync(cachePath, JSON.stringify(payload), "utf8");

    expect(
      readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home }),
    ).toBeNull();
  });

  it("respects PI_CURSOR_MODEL_CACHE_TTL_MS env override", () => {
    const origEnv = process.env.PI_CURSOR_MODEL_CACHE_TTL_MS;
    try {
      process.env.PI_CURSOR_MODEL_CACHE_TTL_MS = "5000"; // 5s

      // Write cache with savedAt 10s ago
      const cachePath = getCursorModelsCachePath(home);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      const payload = {
        items: SAMPLE_ITEMS,
        apiKeyFingerprint: SAMPLE_FINGERPRINT,
        savedAt: Date.now() - 10_000, // 10 seconds ago
      };
      writeFileSync(cachePath, JSON.stringify(payload), "utf8");

      // With custom 5s TTL → expired
      expect(
        readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home }),
      ).toBeNull();
    } finally {
      if (origEnv === undefined) delete process.env.PI_CURSOR_MODEL_CACHE_TTL_MS;
      else process.env.PI_CURSOR_MODEL_CACHE_TTL_MS = origEnv;
    }
  });
});

describe("writeCachedModelList mode 0o600", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cursor-cache-mode-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the cache file with mode 0o600", () => {
    writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
    const stats = statSync(getCursorModelsCachePath(home));
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});

describe("writeCachedModelList mkdir recursive", () => {
  it("creates ~/.pi/agent directory if it does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-cache-mkdir-"));
    try {
      writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home);
      const cached = readCachedModelList({ apiKeyFingerprint: SAMPLE_FINGERPRINT, home });
      expect(cached).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("writeCachedModelList is non-fatal on error", () => {
  it("does not throw when directory cannot be created", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-cache-fail-"));
    try {
      // Create a file where the directory should be
      writeFileSync(join(home, ".pi"), "blocking");
      expect(() =>
        writeCachedModelList(SAMPLE_ITEMS, SAMPLE_FINGERPRINT, home),
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
