import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { syncCommand } from "../../src/commands/sync.js";
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
import { readCatalog, readLock, writeCatalog, writeLock } from "../../src/config/io.js";
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

function emptyLock(): LockFile {
  return { packages: {} };
}

function makeCtx(home = "/tmp/test-home") {
  return {
    home,
    ui: {
      notify: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path stubs
    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedReadCachedGistId.mockReturnValue("cached-gist-123");
    mockedPull.mockResolvedValue({ catalog: sampleCatalog(), lock: sampleLock() });
    mockedScanInstalled.mockReturnValue({});
    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedExecuteActions.mockResolvedValue({ success: true, errors: [] });
    mockedPush.mockResolvedValue({
      gistId: "cached-gist-123",
      gistUrl: "https://gist.github.com/cached-gist-123",
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: pull → reconcile → push
  // -------------------------------------------------------------------------

  it("pulls remote catalog, reconciles, and pushes if changed", async () => {
    const remoteCatalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "my-skill": { source: "npm:my-skill", rating: "core" },
        "new-skill": { source: "npm:new-skill", rating: "useful" },
      },
    };
    mockedPull.mockResolvedValue({ catalog: remoteCatalog, lock: sampleLock() });

    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "new-skill", source: "npm:new-skill" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPull).toHaveBeenCalledWith("default", ctx.home);
    expect(mockedWriteCatalog).toHaveBeenCalledWith(remoteCatalog, ctx.home);
    expect(mockedReconcile).toHaveBeenCalled();
    expect(mockedExecuteActions).toHaveBeenCalled();
    expect(mockedPush).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Synced"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // No changes → no push, reports "up to date"
  // -------------------------------------------------------------------------

  it("skips push when reconcile produces no actions", async () => {
    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedExecuteActions).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already up to date"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // --dry-run shows plan without executing
  // -------------------------------------------------------------------------

  it("dry-run shows plan without executing actions or pushing", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "new-skill", source: "npm:new-skill" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: { "dry-run": true } }, ctx);

    expect(mockedPull).toHaveBeenCalled();
    expect(mockedReconcile).toHaveBeenCalled();
    expect(mockedExecuteActions).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Dry run"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Network error during pull shows warning
  // -------------------------------------------------------------------------

  it("shows warning when pull fails with network error", async () => {
    mockedPull.mockRejectedValue(new Error("network error: ECONNREFUSED"));

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedReconcile).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // No gist: first-time message when catalog is empty
  // -------------------------------------------------------------------------

  it("shows first-time message when no gist exists and local is empty", async () => {
    mockedReadCachedGistId.mockReturnValue(undefined);
    mockedPull.mockRejectedValue(new Error('No gist found for profile "default"'));

    mockedReadCatalog.mockReturnValue({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
    mockedReadLock.mockReturnValue(emptyLock());
    mockedScanInstalled.mockReturnValue({});

    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No remote gist found"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // No gist but local has packages → push local to new gist
  // -------------------------------------------------------------------------

  it("pushes local catalog when no gist exists but local has packages", async () => {
    mockedReadCachedGistId.mockReturnValue(undefined);
    mockedPull.mockRejectedValue(new Error('No gist found for profile "default"'));

    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    mockedPush.mockResolvedValue({
      gistId: "new-gist-abc",
      gistUrl: "https://gist.github.com/new-gist-abc",
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPush).toHaveBeenCalledWith(
      sampleCatalog(),
      sampleLock(),
      "default",
      ctx.home,
    );
  });

  // -------------------------------------------------------------------------
  // Writes lock after sync with actions
  // -------------------------------------------------------------------------

  it("writes lock file after successful sync with actions", async () => {
    const remoteCatalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "new-skill": { source: "npm:new-skill@1.0.0", rating: "core" },
      },
    };
    const remoteLock: LockFile = {
      packages: {
        "new-skill": {
          version: "1.0.0",
          contentHash: "sha256-new",
          installedAt: "2025-06-01T00:00:00Z",
          syncState: "synced",
        },
      },
    };

    mockedPull.mockResolvedValue({ catalog: remoteCatalog, lock: remoteLock });
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "new-skill", source: "npm:new-skill@1.0.0" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedWriteLock).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Push failure shows error
  // -------------------------------------------------------------------------

  it("shows error when push fails", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "new-skill", source: "npm:new-skill" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedPush.mockRejectedValue(new Error("push failed: 403 Forbidden"));

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("push failed"),
      "error",
    );
  });

  // -------------------------------------------------------------------------
  // Reconcile action errors are reported
  // -------------------------------------------------------------------------

  it("reports reconcile action errors", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "bad-pkg", source: "npm:bad-pkg" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedExecuteActions.mockResolvedValue({
      success: false,
      errors: [
        {
          action: { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
          error: new Error("install failed"),
        },
      ],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("install failed"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Reports summary with action counts
  // -------------------------------------------------------------------------

  it("reports summary with install count", async () => {
    mockedReconcile.mockReturnValue({
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
        { type: "install", key: "pkg-b", source: "npm:pkg-b" },
      ],
      uninstalls: [{ type: "uninstall", key: "old-pkg", source: "npm:old-pkg" }],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const summaryCall = notifyCalls.find(
      (c: [string, ...unknown[]]) =>
        typeof c[0] === "string" && c[0].includes("2") && c[0].includes("install"),
    );
    expect(summaryCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Uses profile flag
  // -------------------------------------------------------------------------

  it("passes profile flag to pull and push", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "x", source: "npm:x" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: { profile: "work" } }, ctx);

    expect(mockedPull).toHaveBeenCalledWith("work", ctx.home);
    expect(mockedPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "work",
      ctx.home,
    );
  });

  // -------------------------------------------------------------------------
  // Defaults to "default" profile
  // -------------------------------------------------------------------------

  it("defaults to 'default' profile when no --profile flag", async () => {
    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    expect(mockedPull).toHaveBeenCalledWith("default", ctx.home);
  });

  // -------------------------------------------------------------------------
  // --force flag forces push even when no reconcile actions
  // -------------------------------------------------------------------------

  it("--force flag forces push even when no changes detected", async () => {
    mockedReconcile.mockReturnValue({
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: { force: true } }, ctx);

    // Should still push despite no actions
    expect(mockedPush).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Pushed to gist"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // --no-push flag skips the push step
  // -------------------------------------------------------------------------

  it("--no-push flag skips push step even with changes", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "x", source: "npm:x" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: { "no-push": true } }, ctx);

    expect(mockedExecuteActions).toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Partial failure: pull succeeds, push fails → reports push error
  // -------------------------------------------------------------------------

  it("reports push error when pull succeeds but push fails", async () => {
    mockedReconcile.mockReturnValue({
      installs: [{ type: "install", key: "x", source: "npm:x" }],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    });
    mockedPush.mockRejectedValue(new Error("push failed: network timeout"));

    const ctx = makeCtx();
    await syncCommand({ positional: [], flags: {} }, ctx);

    const allNotifies = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .map((c: [string, ...unknown[]]) => c[0])
      .join(" ");
    expect(allNotifies).toContain("push failed");
  });
});
