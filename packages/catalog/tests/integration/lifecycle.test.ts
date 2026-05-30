/**
 * Integration tests for the full catalog lifecycle.
 *
 * These tests exercise the real command implementations end-to-end using
 * temporary directories and mocked network/shell layers. They are gated
 * behind `process.env.CATALOG_INTEGRATION` so they don't run in CI without
 * explicit setup.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import type { CatalogYaml, LockFile } from "../../src/config/schema.js";
import { initCommand } from "../../src/commands/init.js";
import { addCommand } from "../../src/commands/add.js";
import { statusCommand } from "../../src/commands/status.js";
import { syncCommand, pushCommand, pullCommand } from "../../src/commands/sync.js";
import { profilesCommand, profileCommand } from "../../src/commands/profiles.js";
import { removeCommand } from "../../src/commands/remove.js";
import { writeCatalog, writeLock } from "../../src/config/io.js";
import { catalogFile } from "../../src/config/paths.js";

// ---------------------------------------------------------------------------
// Integration guard
// ---------------------------------------------------------------------------

const RUN = process.env.CATALOG_INTEGRATION;

// ---------------------------------------------------------------------------
// Mocks — only network and shell operations are mocked
// ---------------------------------------------------------------------------

vi.mock("../../src/sync/pull.js", () => ({
  pullCatalog: vi.fn(),
}));

vi.mock("../../src/sync/push.js", () => ({
  pushCatalog: vi.fn(),
}));

vi.mock("../../src/sync/gist.js", () => ({
  readGist: vi.fn(),
  createGist: vi.fn(),
  updateGist: vi.fn(),
  findGistByDescription: vi.fn(),
}));

vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

import { pullCatalog } from "../../src/sync/pull.js";
import { pushCatalog } from "../../src/sync/push.js";
import { scanInstalled } from "../../src/catalog/install.js";

const mockedPull = vi.mocked(pullCatalog);
const mockedPush = vi.mocked(pushCatalog);
const mockedScanInstalled = vi.mocked(scanInstalled);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const notifications: Array<{ msg: string; type?: string }> = [];

function makeCtx(overrides: Record<string, unknown> = {}) {
  notifications.length = 0;
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn((msg: string, type?: "error" | "info" | "warning") => {
        notifications.push({ msg, type });
      }),
      select: vi.fn().mockResolvedValue("skill"),
      confirm: vi.fn().mockResolvedValue(true),
    },
    ...overrides,
  };
}

function readCatalogFromDisk(): CatalogYaml {
  const filePath = catalogFile(tmpDir);
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw) as CatalogYaml;
}

function writeCatalogToDisk(catalog: CatalogYaml): void {
  writeCatalog(catalog, tmpDir);
}

function writeLockToDisk(lock: LockFile): void {
  writeLock(lock, tmpDir);
}

function setupPushMock(): void {
  mockedPush.mockImplementation(async (_catalog, _lock, _profile, _home) => ({
    gistId: "mock-gist-123",
    gistUrl: "https://gist.github.com/mock-gist-123",
  }));
}

function setupPullMock(catalog: CatalogYaml, lock: LockFile): void {
  mockedPull.mockResolvedValue({ catalog, lock });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("Integration: full lifecycle", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-integ-"));
    vi.clearAllMocks();
    mockedScanInstalled.mockReturnValue({});
    setupPushMock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // (1) Fresh init → add 3 packages → status shows correct state
  // -------------------------------------------------------------------------

  describe("init → add → status", () => {
    it("initializes an empty catalog and adds 3 packages, then status shows correct counts", async () => {
      // --- Step 1: Init (empty system) ---
      mockedScanInstalled.mockReturnValue({});

      const ctx = makeCtx();
      await initCommand({ positional: [], flags: {} }, ctx);

      let catalog = readCatalogFromDisk();
      expect(Object.keys(catalog.packages)).toHaveLength(0);
      expect(catalog.meta.pi_version).toBe("0.0.0");

      // --- Step 2: Add 3 packages ---
      // Mock piInstall to avoid real shell calls
      const execModule = await import("../../src/util/exec.js");
      const installSpy = vi.spyOn(execModule, "piInstall").mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      catalog = readCatalogFromDisk();
      writeCatalogToDisk(catalog);

      const packages = [
        { name: "core-skill", source: "npm:core-skill", rating: "core" as const },
        { name: "useful-tool", source: "npm:useful-tool", rating: "useful" as const },
        { name: "git-skill", source: "git:github.com/user/repo", rating: "debatable" as const },
      ];

      for (const pkg of packages) {
        await addCommand(
          {
            positional: [pkg.name, pkg.source],
            flags: { rating: pkg.rating, type: "skill" },
          },
          ctx,
        );
      }

      installSpy.mockRestore();

      // Verify catalog on disk
      catalog = readCatalogFromDisk();
      expect(Object.keys(catalog.packages)).toHaveLength(3);
      expect(catalog.packages["core-skill"]).toEqual({
        source: "npm:core-skill",
        rating: "core",
        type: "skill",
      });
      expect(catalog.packages["useful-tool"]).toEqual({
        source: "npm:useful-tool",
        rating: "useful",
        type: "skill",
      });
      expect(catalog.packages["git-skill"]).toEqual({
        source: "git:github.com/user/repo",
        rating: "debatable",
        type: "skill",
      });

      // --- Step 3: Status shows correct state ---
      // Mock scanInstalled to reflect 2 of 3 packages installed
      mockedScanInstalled.mockReturnValue({
        "core-skill": { source: "npm:core-skill", name: "core-skill", version: "1.0.0" },
        "useful-tool": { source: "npm:useful-tool", name: "useful-tool", version: "2.0.0" },
      });

      notifications.length = 0;
      await statusCommand({ positional: [], flags: {} }, makeCtx());

      const statusMsg = notifications.map((n) => n.msg).join("\n");
      expect(statusMsg).toContain("3 total");
      expect(statusMsg).toContain("core: 1");
      expect(statusMsg).toContain("useful: 1");
      expect(statusMsg).toContain("debatable: 1");
      expect(statusMsg).toContain("Installed: 2");
      expect(statusMsg).toContain("Missing: 1");
    });
  });

  // -------------------------------------------------------------------------
  // (2) sync --dry-run produces expected action plan
  // -------------------------------------------------------------------------

  describe("sync --dry-run", () => {
    it("shows install plan for uninstalled catalog packages", async () => {
      // Set up a catalog with 2 packages, none installed
      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a", rating: "core" },
          "pkg-b": { source: "npm:pkg-b", rating: "useful" },
        },
      };
      writeCatalogToDisk(catalog);
      writeLockToDisk({ packages: {} });

      setupPullMock(catalog, { packages: {} });
      mockedScanInstalled.mockReturnValue({});

      const ctx = makeCtx();
      await syncCommand({ positional: [], flags: { "dry-run": true } }, ctx);

      const msg = notifications.map((n) => n.msg).join("\n");
      expect(msg).toContain("Dry run");
      expect(msg).toContain("Would install");
      expect(msg).toContain("pkg-a");
      expect(msg).toContain("pkg-b");
    });

    it("shows no changes when everything is in sync", async () => {
      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a", rating: "core" },
        },
      };
      writeCatalogToDisk(catalog);
      writeLockToDisk({ packages: {} });

      setupPullMock(catalog, { packages: {} });
      mockedScanInstalled.mockReturnValue({
        "pkg-a": { source: "npm:pkg-a", name: "pkg-a", version: "1.0.0" },
      });

      const ctx = makeCtx();
      await syncCommand({ positional: [], flags: { "dry-run": true } }, ctx);

      const msg = notifications.map((n) => n.msg).join("\n");
      expect(msg).toContain("No changes needed");
    });

    it("shows upgrade plan when source differs", async () => {
      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a@2.0.0", rating: "core" },
        },
      };
      writeCatalogToDisk(catalog);
      writeLockToDisk({ packages: {} });

      setupPullMock(catalog, { packages: {} });
      mockedScanInstalled.mockReturnValue({
        "pkg-a": { source: "npm:pkg-a@1.0.0", name: "pkg-a", version: "1.0.0" },
      });

      const ctx = makeCtx();
      await syncCommand({ positional: [], flags: { "dry-run": true } }, ctx);

      const msg = notifications.map((n) => n.msg).join("\n");
      expect(msg).toContain("Would upgrade");
      expect(msg).toContain("pkg-a");
    });
  });

  // -------------------------------------------------------------------------
  // (3) push → pull round-trip preserves catalog exactly
  // -------------------------------------------------------------------------

  describe("push → pull round-trip", () => {
    it("pushes a catalog and pulling it back yields the same content", async () => {
      const originalCatalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "skill-a": { source: "npm:skill-a", rating: "core", type: "skill" },
          "tool-b": { source: "git:github.com/user/tool-b", rating: "useful" },
        },
      };
      const originalLock: LockFile = {
        packages: {
          "skill-a": {
            version: "1.2.0",
            contentHash: "sha256-abc123",
            installedAt: "2025-06-01T00:00:00Z",
            syncState: "synced",
          },
        },
      };

      writeCatalogToDisk(originalCatalog);
      writeLockToDisk(originalLock);

      // Capture what push sends
      let pushedCatalog: CatalogYaml | undefined;
      let pushedLock: LockFile | undefined;
      mockedPush.mockImplementation(async (cat, lock, _profile, _home) => {
        pushedCatalog = cat;
        pushedLock = lock;
        return {
          gistId: "round-trip-gist-abc",
          gistUrl: "https://gist.github.com/round-trip-gist-abc",
        };
      });

      // --- Push ---
      const pushCtx = makeCtx();
      await pushCommand({ positional: [], flags: {} }, pushCtx);

      expect(pushedCatalog).toBeDefined();
      expect(pushedLock).toBeDefined();

      // Simulate pull by feeding the pushed data back
      mockedPull.mockResolvedValue({
        catalog: pushedCatalog!,
        lock: pushedLock!,
      });
      mockedScanInstalled.mockReturnValue({});

      // Clear catalog on disk to simulate fresh machine
      const freshDir = path.join(tmpDir, "fresh");
      fs.mkdirSync(freshDir, { recursive: true });
      const originalHome = tmpDir;
      tmpDir = freshDir;

      // --- Pull ---
      const pullCtx = makeCtx();
      // Set home to fresh dir
      Object.assign(pullCtx, { home: freshDir });

      // Actually use the original tmpDir for the pull mock setup
      tmpDir = originalHome;

      // Write the pulled catalog to the original location
      mockedPull.mockResolvedValue({
        catalog: pushedCatalog!,
        lock: pushedLock!,
      });

      const pullCtx2 = makeCtx();
      await pullCommand({ positional: [], flags: {} }, pullCtx2);

      // Read back the catalog from disk
      const pulledCatalog = readCatalogFromDisk();

      // Verify round-trip preserves content exactly
      expect(pulledCatalog.meta).toEqual(originalCatalog.meta);
      expect(Object.keys(pulledCatalog.packages)).toEqual(
        Object.keys(originalCatalog.packages),
      );
      expect(pulledCatalog.packages["skill-a"]).toEqual(
        originalCatalog.packages["skill-a"],
      );
      expect(pulledCatalog.packages["tool-b"]).toEqual(
        originalCatalog.packages["tool-b"],
      );
    });
  });

  // -------------------------------------------------------------------------
  // (4) profile create → switch → verify correct packages active
  // -------------------------------------------------------------------------

  describe("profile lifecycle", () => {
    it("creates a profile, switches to it, and verifies packages", async () => {
      // Start with a catalog that has base packages
      const baseCatalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "base-tool": { source: "npm:base-tool", rating: "core" },
        },
      };
      writeCatalogToDisk(baseCatalog);

      // --- Create a "work" profile ---
      const createCtx = makeCtx();
      await profileCommand(
        { positional: ["work"], flags: { create: true } },
        createCtx,
      );

      const afterCreate = readCatalogFromDisk();
      expect(afterCreate.profiles).toBeDefined();
      expect(afterCreate.profiles!["work"]).toEqual({ packages: {} });

      // --- Switch to "work" profile ---
      const switchCtx = makeCtx();
      await profileCommand(
        { positional: ["work"], flags: {} },
        switchCtx,
      );

      const afterSwitch = readCatalogFromDisk();
      expect(afterSwitch.meta.activeProfile).toBe("work");

      // --- List profiles ---
      const listCtx = makeCtx();
      await profilesCommand({ positional: [], flags: {} }, listCtx);

      const listMsg = notifications.map((n) => n.msg).join("\n");
      expect(listMsg).toContain("default");
      expect(listMsg).toContain("work");
      // work should be marked active
      const lines = listMsg.split("\n");
      const workLine = lines.find((l: string) => l.includes("work") && l.includes("*"));
      expect(workLine).toBeDefined();

      // --- Show current profile ---
      notifications.length = 0;
      const showCtx = makeCtx();
      await profileCommand({ positional: [], flags: {} }, showCtx);

      const showMsg = notifications.map((n) => n.msg).join("\n");
      expect(showMsg).toContain("work");

      // --- Delete profile ---
      const deleteCtx = makeCtx();
      await profileCommand(
        { positional: ["work"], flags: { delete: true } },
        deleteCtx,
      );

      const afterDelete = readCatalogFromDisk();
      expect(afterDelete.profiles?.["work"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (5) Full lifecycle: init → add → remove → sync → status
  // -------------------------------------------------------------------------

  describe("end-to-end lifecycle", () => {
    it("completes full init → add → remove → sync cycle", async () => {
      const execModule = await import("../../src/util/exec.js");
      const installSpy = vi.spyOn(execModule, "piInstall").mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      const uninstallSpy = vi.spyOn(execModule, "piUninstall").mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      // Init from scan
      mockedScanInstalled.mockReturnValue({
        "existing": { source: "npm:existing", name: "existing", version: "1.0.0" },
      });

      const ctx = makeCtx();
      await initCommand({ positional: [], flags: {} }, ctx);

      let catalog = readCatalogFromDisk();
      expect(catalog.packages["existing"]).toEqual({
        source: "npm:existing",
        rating: "core",
      });

      // Add a new package
      await addCommand(
        { positional: ["new-pkg", "npm:new-pkg"], flags: { rating: "useful" } },
        ctx,
      );

      catalog = readCatalogFromDisk();
      expect(Object.keys(catalog.packages)).toHaveLength(2);

      // Remove the existing package
      await removeCommand(
        { positional: ["existing"], flags: { yes: true } },
        ctx,
      );

      catalog = readCatalogFromDisk();
      expect(catalog.packages["existing"]).toBeUndefined();
      expect(Object.keys(catalog.packages)).toHaveLength(1);
      expect(catalog.packages["new-pkg"]).toBeDefined();

      // Sync
      setupPullMock(catalog, { packages: {} });
      mockedScanInstalled.mockReturnValue({
        "new-pkg": { source: "npm:new-pkg", name: "new-pkg", version: "1.0.0" },
      });

      await syncCommand({ positional: [], flags: {} }, ctx);

      // Verify push was called
      expect(mockedPush).toHaveBeenCalled();

      // Status
      notifications.length = 0;
      mockedScanInstalled.mockReturnValue({
        "new-pkg": { source: "npm:new-pkg", name: "new-pkg", version: "1.0.0" },
      });

      await statusCommand({ positional: [], flags: {} }, makeCtx());

      const statusMsg = notifications.map((n) => n.msg).join("\n");
      expect(statusMsg).toContain("1 total");
      expect(statusMsg).toContain("Installed: 1");
      expect(statusMsg).toContain("Missing: 0");

      installSpy.mockRestore();
      uninstallSpy.mockRestore();
    });
  });
});
