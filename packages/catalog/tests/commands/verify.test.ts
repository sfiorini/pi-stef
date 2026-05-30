import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { verifyCommand, type VerifyCtx } from "../../src/commands/verify.js";
import type { CatalogYaml, LockFile } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config/io.js", () => ({
  readCatalog: vi.fn(),
  readLock: vi.fn(),
}));

vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

import { readCatalog, readLock } from "../../src/config/io.js";
import { scanInstalled } from "../../src/catalog/install.js";

const mockedReadCatalog = vi.mocked(readCatalog);
const mockedReadLock = vi.mocked(readLock);
const mockedScanInstalled = vi.mocked(scanInstalled);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sampleCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "valid-npm": {
        source: "npm:valid-npm",
        rating: "core",
      },
      "valid-git": {
        source: "git:github.com/user/repo",
        rating: "useful",
      },
    },
  };
}

function sampleLock(): LockFile {
  return {
    packages: {
      "valid-npm": {
        version: "1.0.0",
        contentHash: "sha256-abc",
        installedAt: "2025-01-01T00:00:00Z",
        syncState: "synced",
      },
      "valid-git": {
        version: "unknown",
        contentHash: "sha256-def",
        installedAt: "2025-01-01T00:00:00Z",
        syncState: "synced",
      },
    },
  };
}

function makeCtx(): VerifyCtx {
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-verify-"));
    vi.clearAllMocks();

    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedScanInstalled.mockReturnValue({
      "valid-npm": { source: "npm:valid-npm", name: "valid-npm", version: "1.0.0" },
      "valid-git": { source: "git:github.com/user/repo", name: "github.com/user/repo", version: undefined },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Reports all checks passed when catalog is healthy
  // -------------------------------------------------------------------------

  it("reports all checks passed when catalog is valid", async () => {
    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("All checks passed"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Detects invalid source formats
  // -------------------------------------------------------------------------

  it("detects packages with invalid source format", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "1.0.0" },
      packages: {
        "bad-source": {
          source: "invalid://not-a-valid-source",
          rating: "core",
        },
      },
    });
    mockedReadLock.mockReturnValue({ packages: {} });

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("invalid source"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Detects missing lock entries
  // -------------------------------------------------------------------------

  it("detects packages in catalog but missing from lock", async () => {
    // Catalog has valid-npm but lock is empty
    mockedReadLock.mockReturnValue({ packages: {} });

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("missing from lock"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Detects stale lock entries (packages in lock but not in catalog)
  // -------------------------------------------------------------------------

  it("detects packages in lock but missing from catalog", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "1.0.0" },
      packages: {},
    });
    // Lock still has entries
    mockedReadLock.mockReturnValue(sampleLock());

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not in catalog"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Detects sync state mismatches (outdated/conflict entries in lock)
  // -------------------------------------------------------------------------

  it("detects packages with non-synced lock state", async () => {
    mockedReadLock.mockReturnValue({
      packages: {
        "valid-npm": {
          version: "1.0.0",
          contentHash: "sha256-abc",
          installedAt: "2025-01-01T00:00:00Z",
          syncState: "outdated",
        },
        "valid-git": {
          version: "unknown",
          contentHash: "sha256-def",
          installedAt: "2025-01-01T00:00:00Z",
          syncState: "conflict",
        },
      },
    });

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const warningCalls = notifyCalls.filter(
      (c: [string, ...unknown[]]) => c[1] === "warning",
    );
    expect(warningCalls.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Handles empty catalog
  // -------------------------------------------------------------------------

  it("passes for empty catalog with empty lock", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
    mockedReadLock.mockReturnValue({ packages: {} });
    mockedScanInstalled.mockReturnValue({});

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("All checks passed"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Reports summary with check counts
  // -------------------------------------------------------------------------

  it("reports summary with total package count and issue count", async () => {
    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    // Should mention the number of packages checked
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("2"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Reports installed-but-not-in-catalog as orphans
  // -------------------------------------------------------------------------

  it("detects installed packages not in catalog as orphans", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "1.0.0" },
      packages: {},
    });
    mockedReadLock.mockReturnValue({ packages: {} });
    mockedScanInstalled.mockReturnValue({
      "orphan-pkg": { source: "npm:orphan-pkg", name: "orphan-pkg", version: "1.0.0" },
    });

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("orphan"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Handles empty source string
  // -------------------------------------------------------------------------

  it("detects packages with empty source", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "1.0.0" },
      packages: {
        "empty-source": {
          source: "",
          rating: "core",
        },
      },
    });
    mockedReadLock.mockReturnValue({ packages: {} });

    const ctx = makeCtx();
    await verifyCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("invalid source"),
      "warning",
    );
  });
});
