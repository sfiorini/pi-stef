import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config/paths.js", () => ({
  catalogDir: vi.fn(() => "/mock/home/.pi/sf/catalog"),
  catalogFile: vi.fn(() => "/mock/home/.pi/sf/catalog/cat.yaml"),
  lockFile: vi.fn(() => "/mock/home/.pi/sf/catalog/catalog.lock.json"),
  ensureCatalogDir: vi.fn(),
}));

// We do NOT mock io.js — we want to test through the real readLock/writeLock
// path to verify that _updateCache survives Zod validation (P0 fix).
// Instead, mock the fs layer so no real files are touched.

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

import fs from "node:fs";
import { readUpdateCache, writeUpdateCache } from "../../src/update/update-cache.js";

// Access the mocked functions via the imported module.
const mockedFs = vi.mocked(fs, true);

// Helper: set the lock file content that fs.readFileSync will return.
function setLockFileContent(obj: Record<string, unknown>): void {
  mockedFs.readFileSync.mockReturnValue(JSON.stringify(obj));
}

// ===========================================================================
// readUpdateCache
// ===========================================================================
describe("readUpdateCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
  });

  it("returns undefined when lock has no _updateCache key", () => {
    setLockFileContent({ packages: {} });

    const result = readUpdateCache("self-update");

    expect(result).toBeUndefined();
  });

  it("returns undefined when cache key does not exist", () => {
    setLockFileContent({
      packages: {},
      _updateCache: {
        "other-key": { latest: "1.0.0", checkedAt: new Date().toISOString() },
      },
    });

    const result = readUpdateCache("self-update");

    expect(result).toBeUndefined();
  });

  it("returns cached entry when fresh (< 1 hour old)", () => {
    const checkedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    setLockFileContent({
      packages: {},
      _updateCache: {
        "self-update": { latest: "2.0.0", checkedAt },
      },
    });

    const result = readUpdateCache("self-update");

    expect(result).toEqual({ latest: "2.0.0", checkedAt });
  });

  it("returns undefined when cache is older than 1 hour", () => {
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setLockFileContent({
      packages: {},
      _updateCache: {
        "self-update": { latest: "2.0.0", checkedAt },
      },
    });

    const result = readUpdateCache("self-update");

    expect(result).toBeUndefined();
  });

  it("survives _updateCache through real Zod parse (P0 passthrough)", () => {
    // This test proves that _updateCache is NOT stripped by Zod validation.
    const checkedAt = new Date(Date.now() - 1000).toISOString();
    setLockFileContent({
      packages: {},
      _updateCache: {
        "pi-update": { latest: "5.0.0", checkedAt },
      },
    });

    const result = readUpdateCache("pi-update");

    expect(result).toEqual({ latest: "5.0.0", checkedAt });
  });
});

// ===========================================================================
// writeUpdateCache
// ===========================================================================
describe("writeUpdateCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    setLockFileContent({ packages: {} });
  });

  it("writes _updateCache into the lock file", () => {
    const entry = { latest: "3.0.0", checkedAt: new Date().toISOString() };

    writeUpdateCache("self-update", entry);

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    const written = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed._updateCache).toBeDefined();
    expect(parsed._updateCache["self-update"]).toEqual(entry);
  });

  it("preserves existing packages when writing cache", () => {
    setLockFileContent({
      packages: {
        "my-pkg": {
          version: "1.0.0",
          contentHash: "abc123",
          installedAt: "2025-01-01T00:00:00Z",
          syncState: "synced",
        },
      },
    });

    writeUpdateCache("self-update", {
      latest: "2.0.0",
      checkedAt: new Date().toISOString(),
    });

    const written = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.packages["my-pkg"]).toBeDefined();
    expect(parsed._updateCache["self-update"]).toBeDefined();
  });
});
