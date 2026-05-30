import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { statusCommand, type StatusCtx } from "../../src/commands/status.js";
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

vi.mock("../../src/sync/cache.js", () => ({
  readCachedGistId: vi.fn(),
  gistCachePath: vi.fn(),
}));

import { readCatalog, readLock } from "../../src/config/io.js";
import { scanInstalled } from "../../src/catalog/install.js";
import { readCachedGistId } from "../../src/sync/cache.js";

const mockedReadCatalog = vi.mocked(readCatalog);
const mockedReadLock = vi.mocked(readLock);
const mockedScanInstalled = vi.mocked(scanInstalled);
const mockedReadCachedGistId = vi.mocked(readCachedGistId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sampleCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "core-skill": {
        source: "npm:core-skill",
        rating: "core",
        enabled: true,
      },
      "useful-skill": {
        source: "npm:useful-skill",
        rating: "useful",
        enabled: true,
      },
      "debatable-skill": {
        source: "npm:debatable-skill",
        rating: "debatable",
        enabled: true,
      },
      "disabled-skill": {
        source: "npm:disabled-skill",
        rating: "disabled",
        enabled: false,
        previousRating: "core",
      },
    },
  };
}

function sampleLock(): LockFile {
  return {
    packages: {
      "core-skill": {
        version: "1.0.0",
        contentHash: "sha256-abc",
        installedAt: "2025-01-15T10:30:00Z",
        syncState: "synced",
      },
      "useful-skill": {
        version: "2.0.0",
        contentHash: "sha256-def",
        installedAt: "2025-01-14T08:00:00Z",
        syncState: "synced",
      },
    },
  };
}

function makeCtx(): StatusCtx {
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

describe("statusCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-status-"));
    vi.clearAllMocks();

    // Default stubs
    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedReadCachedGistId.mockReturnValue("gist-abc123");
    mockedScanInstalled.mockReturnValue({
      "core-skill": { source: "npm:core-skill", name: "core-skill", version: "1.0.0" },
      "useful-skill": { source: "npm:useful-skill", name: "useful-skill", version: "2.0.0" },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Shows profile
  // -------------------------------------------------------------------------

  it("shows the active profile name", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("default"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Shows package counts by rating
  // -------------------------------------------------------------------------

  it("shows package counts grouped by rating", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusCall = notifyCalls.find(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("core"),
    );
    expect(statusCall).toBeDefined();
    expect(statusCall![0]).toContain("core");
  });

  // -------------------------------------------------------------------------
  // Shows installed/missing/orphan counts
  // -------------------------------------------------------------------------

  it("reports installed, missing, and orphan counts", async () => {
    // Only core-skill is installed; useful-skill and debatable-skill are missing
    // orphan-pkg is installed but not in catalog
    mockedScanInstalled.mockReturnValue({
      "core-skill": { source: "npm:core-skill", name: "core-skill", version: "1.0.0" },
      "orphan-pkg": { source: "npm:orphan-pkg", name: "orphan-pkg", version: "3.0.0" },
    });

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("Installed: 1");
    expect(statusMsg).toContain("Missing: 3");
    expect(statusMsg).toContain("Orphans: 1");
  });

  // -------------------------------------------------------------------------
  // Shows gist URL when cached gist exists
  // -------------------------------------------------------------------------

  it("shows gist URL when a cached gist ID exists", async () => {
    mockedReadCachedGistId.mockReturnValue("gist-abc123");

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("gist.github.com/gist-abc123"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Shows "no gist" when no cached gist
  // -------------------------------------------------------------------------

  it("shows 'no gist' when no cached gist ID exists", async () => {
    mockedReadCachedGistId.mockReturnValue(undefined);

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No remote gist"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Shows last sync time from lock file
  // -------------------------------------------------------------------------

  it("shows last sync time from lock file timestamps", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("2025-01-15"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Shows "never synced" when lock is empty
  // -------------------------------------------------------------------------

  it("shows 'never synced' when lock file has no packages", async () => {
    mockedReadLock.mockReturnValue({ packages: {} });

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("never synced"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Uses --profile flag
  // -------------------------------------------------------------------------

  it("uses --profile flag when provided", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: { profile: "work" } }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("work"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Empty catalog shows zero counts
  // -------------------------------------------------------------------------

  it("handles empty catalog gracefully", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
    mockedReadLock.mockReturnValue({ packages: {} });
    mockedScanInstalled.mockReturnValue({});

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("0 total"),
      "info",
    );
  });
});
