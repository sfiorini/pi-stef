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

vi.mock("../../src/catalog/setup.js", () => ({
  checkSetupForSource: vi.fn(),
}));

import { readCatalog, readLock } from "../../src/config/io.js";
import { scanInstalled } from "../../src/catalog/install.js";
import { readCachedGistId } from "../../src/sync/cache.js";
import { checkSetupForSource } from "../../src/catalog/setup.js";

const mockedReadCatalog = vi.mocked(readCatalog);
const mockedReadLock = vi.mocked(readLock);
const mockedScanInstalled = vi.mocked(scanInstalled);
const mockedReadCachedGistId = vi.mocked(readCachedGistId);
const mockedCheckSetupForSource = vi.mocked(checkSetupForSource);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sampleCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "enabled-skill-1": {
        source: "npm:enabled-skill-1",
      },
      "enabled-skill-2": {
        source: "npm:enabled-skill-2",
      },
      "disabled-skill": {
        source: "npm:disabled-skill",
        enabled: false,
      },
    },
  };
}

function sampleLock(): LockFile {
  return {
    packages: {
      "enabled-skill-1": {
        version: "1.0.0",
        sourceHash: "sha256-abc",
        installedAt: "2025-01-15T10:30:00Z",
        syncState: "synced",
      },
      "enabled-skill-2": {
        version: "2.0.0",
        sourceHash: "sha256-def",
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
      "enabled-skill-1": { source: "npm:enabled-skill-1", name: "enabled-skill-1", version: "1.0.0" },
      "enabled-skill-2": { source: "npm:enabled-skill-2", name: "enabled-skill-2", version: "2.0.0" },
    });
    mockedCheckSetupForSource.mockReturnValue(undefined);
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
  // Shows package counts by enabled/disabled
  // -------------------------------------------------------------------------

  it("shows package counts grouped by enabled/disabled", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls
      .map((c) => c[0])
      .filter((m) => typeof m === "string")
      .join("\n");
    expect(statusMsg).toContain("2 enabled");
    expect(statusMsg).toContain("1 disabled");
  });

  // -------------------------------------------------------------------------
  // Shows installed/missing/orphan counts
  // -------------------------------------------------------------------------

  it("reports installed, missing, and orphan counts", async () => {
    // Only enabled-skill-1 is installed; enabled-skill-2 and disabled-skill are missing
    // orphan-pkg is installed but not in catalog
    mockedScanInstalled.mockReturnValue({
      "enabled-skill-1": { source: "npm:enabled-skill-1", name: "enabled-skill-1", version: "1.0.0" },
      "orphan-pkg": { source: "npm:orphan-pkg", name: "orphan-pkg", version: "3.0.0" },
    });

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("Installed: 1");
    expect(statusMsg).toContain("Missing: 2");
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

  // -------------------------------------------------------------------------
  // Individual package listing
  // -------------------------------------------------------------------------

  it("lists individual packages with status indicators", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("enabled-skill-1 [installed]");
    expect(statusMsg).toContain("enabled-skill-2 [installed]");
    expect(statusMsg).toContain("disabled-skill [disabled]");
  });

  it("shows missing status for uninstalled packages", async () => {
    mockedScanInstalled.mockReturnValue({});

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("enabled-skill-1 [missing]");
    expect(statusMsg).toContain("enabled-skill-2 [missing]");
  });

  it("shows version info for installed packages", async () => {
    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("v1.0.0");
    expect(statusMsg).toContain("v2.0.0");
  });

  it("shows setup warning for packages with incomplete setup", async () => {
    mockedCheckSetupForSource.mockReturnValue({
      ok: false,
      missingEnv: ["API_KEY"],
      missingFiles: [],
      missingCli: [],
    });

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("⚠ setup incomplete");
  });

  it("lists orphan packages separately", async () => {
    mockedScanInstalled.mockReturnValue({
      "enabled-skill-1": { source: "npm:enabled-skill-1", name: "enabled-skill-1", version: "1.0.0" },
      "orphan-pkg": { source: "npm:orphan-pkg", name: "orphan-pkg", version: "3.0.0" },
    });

    const ctx = makeCtx();
    await statusCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const statusMsg = notifyCalls[0][0] as string;
    expect(statusMsg).toContain("Orphans:");
    expect(statusMsg).toContain("orphan-pkg [orphan]");
    expect(statusMsg).toContain("v3.0.0");
  });
});
