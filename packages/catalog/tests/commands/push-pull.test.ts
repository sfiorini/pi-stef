import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  pushCommand,
  pullCommand,
  type PushPullCtx,
} from "../../src/commands/sync.js";
import type { CatalogYaml, LockFile } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/sync/pull.js", () => ({
  pullCatalog: vi.fn(),
}));

vi.mock("../../src/sync/push.js", () => ({
  pushCatalog: vi.fn(),
}));

vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

vi.mock("../../src/catalog/reconcile.js", () => ({
  reconcile: vi.fn(),
  executeActions: vi.fn(),
}));

vi.mock("../../src/config/io.js", () => ({
  readCatalog: vi.fn(),
  readLock: vi.fn(),
  writeCatalog: vi.fn(),
  writeLock: vi.fn(),
}));

vi.mock("../../src/sync/cache.js", () => ({
  readCachedGistId: vi.fn(),
  writeCachedGistId: vi.fn(),
  gistCachePath: vi.fn(),
}));

import { pullCatalog } from "../../src/sync/pull.js";
import { pushCatalog } from "../../src/sync/push.js";
import { scanInstalled } from "../../src/catalog/install.js";
import { reconcile, executeActions } from "../../src/catalog/reconcile.js";
import {
  readCatalog,
  readLock,
  writeCatalog,
  writeLock,
} from "../../src/config/io.js";
import { readCachedGistId } from "../../src/sync/cache.js";

const mockedPull = vi.mocked(pullCatalog);
const mockedPush = vi.mocked(pushCatalog);
const mockedScanInstalled = vi.mocked(scanInstalled);
const mockedReconcile = vi.mocked(reconcile);
const mockedExecuteActions = vi.mocked(executeActions);
const mockedReadCatalog = vi.mocked(readCatalog);
const mockedReadLock = vi.mocked(readLock);
const mockedWriteCatalog = vi.mocked(writeCatalog);
const mockedWriteLock = vi.mocked(writeLock);
const mockedReadCachedGistId = vi.mocked(readCachedGistId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sampleCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-skill": {
        source: "npm:my-skill",
        rating: "core",
      },
    },
  };
}

function sampleLock(): LockFile {
  return {
    packages: {
      "my-skill": {
        version: "1.0.0",
        contentHash: "sha256-abc",
        installedAt: "2025-01-01T00:00:00Z",
        syncState: "synced",
      },
    },
  };
}

function makeCtx(): PushPullCtx {
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

describe("pushCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-push-"));
    vi.clearAllMocks();

    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedReadCachedGistId.mockReturnValue("cached-gist-123");
    mockedPush.mockResolvedValue({
      gistId: "cached-gist-123",
      gistUrl: "https://gist.github.com/cached-gist-123",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path: serializes + uploads, returns gist URL
  // -------------------------------------------------------------------------

  it("reads local catalog and lock and pushes to gist", async () => {
    const ctx = makeCtx();
    await pushCommand({ positional: [], flags: {} }, ctx);

    // Should read local catalog and lock
    expect(mockedReadCatalog).toHaveBeenCalledWith(tmpDir);
    expect(mockedReadLock).toHaveBeenCalledWith(tmpDir);

    // Should push using the pushCatalog function
    expect(mockedPush).toHaveBeenCalledWith(
      sampleCatalog(),
      sampleLock(),
      "default",
      tmpDir,
    );

    // Should notify success with gist URL
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("https://gist.github.com/cached-gist-123"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Respects --profile flag
  // -------------------------------------------------------------------------

  it("passes profile flag to pushCatalog", async () => {
    const ctx = makeCtx();
    await pushCommand({ positional: [], flags: { profile: "work" } }, ctx);

    expect(mockedPush).toHaveBeenCalledWith(
      sampleCatalog(),
      sampleLock(),
      "work",
      tmpDir,
    );
  });

  // -------------------------------------------------------------------------
  // Defaults to "default" profile
  // -------------------------------------------------------------------------

  it("defaults to 'default' profile when no --profile flag", async () => {
    const ctx = makeCtx();
    await pushCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "default",
      tmpDir,
    );
  });

  // -------------------------------------------------------------------------
  // Push failure shows error
  // -------------------------------------------------------------------------

  it("shows error when push fails", async () => {
    mockedPush.mockRejectedValue(new Error("network error: 503"));

    const ctx = makeCtx();
    await pushCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
      "error",
    );
  });

  // -------------------------------------------------------------------------
  // Empty catalog pushes successfully
  // -------------------------------------------------------------------------

  it("pushes empty catalog without error", async () => {
    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
    mockedReadLock.mockReturnValue({ packages: {} });

    const ctx = makeCtx();
    await pushCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPush).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Pushed"),
      "info",
    );
  });
});

// ===========================================================================
// pullCommand
// ===========================================================================

describe("pullCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-pull-"));
    vi.clearAllMocks();

    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedPull.mockResolvedValue({
      catalog: sampleCatalog(),
      lock: sampleLock(),
    });
    mockedScanInstalled.mockReturnValue({});
    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedExecuteActions.mockResolvedValue({ success: true, errors: [] });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path: downloads + applies + reconciles
  // -------------------------------------------------------------------------

  it("pulls remote catalog, writes locally, and reconciles", async () => {
    const remoteCatalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "remote-skill": { source: "npm:remote-skill", rating: "useful" },
      },
    };
    const remoteLock: LockFile = {
      packages: {
        "remote-skill": {
          version: "2.0.0",
          contentHash: "sha256-remote",
          installedAt: "2025-06-01T00:00:00Z",
          syncState: "synced",
        },
      },
    };
    mockedPull.mockResolvedValue({
      catalog: remoteCatalog,
      lock: remoteLock,
    });

    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    // Should pull from gist
    expect(mockedPull).toHaveBeenCalledWith("default", tmpDir);

    // Should write pulled catalog and lock to local
    expect(mockedWriteCatalog).toHaveBeenCalledWith(remoteCatalog, tmpDir);
    expect(mockedWriteLock).toHaveBeenCalledWith(remoteLock, tmpDir);

    // Should reconcile
    expect(mockedReconcile).toHaveBeenCalled();

    // Should notify success
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Pulled"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Reconciles and executes install actions
  // -------------------------------------------------------------------------

  it("executes install actions after pull when packages are new", async () => {
    const remoteCatalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "new-pkg": { source: "npm:new-pkg", rating: "core" },
      },
    };
    mockedPull.mockResolvedValue({
      catalog: remoteCatalog,
      lock: sampleLock(),
    });

    mockedReconcile.mockReturnValue({
      installs: [
        { type: "install", key: "new-pkg", source: "npm:new-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    expect(mockedExecuteActions).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("1 install"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Respects --profile flag
  // -------------------------------------------------------------------------

  it("passes profile flag to pullCatalog", async () => {
    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: { profile: "work" } }, ctx);

    expect(mockedPull).toHaveBeenCalledWith("work", tmpDir);
  });

  // -------------------------------------------------------------------------
  // Defaults to "default" profile
  // -------------------------------------------------------------------------

  it("defaults to 'default' profile when no --profile flag", async () => {
    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPull).toHaveBeenCalledWith("default", tmpDir);
  });

  // -------------------------------------------------------------------------
  // Pull failure shows error
  // -------------------------------------------------------------------------

  it("shows error when pull fails", async () => {
    mockedPull.mockRejectedValue(new Error("network error: ECONNREFUSED"));

    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
      "error",
    );
  });

  // -------------------------------------------------------------------------
  // No changes needed — reports up to date
  // -------------------------------------------------------------------------

  it("reports 'up to date' when no reconcile actions needed", async () => {
    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    // Execute should not be called when there are no actions
    expect(mockedExecuteActions).not.toHaveBeenCalled();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("up to date"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Reconcile action errors are reported
  // -------------------------------------------------------------------------

  it("reports errors from action execution", async () => {
    mockedReconcile.mockReturnValue({
      installs: [
        { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedExecuteActions.mockResolvedValue({
      success: false,
      errors: [
        {
          action: { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
          error: new Error("install failed: npm not found"),
        },
      ],
    });

    const ctx = makeCtx();
    await pullCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("install failed"),
      "warning",
    );
  });
});
