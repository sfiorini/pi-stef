import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  reconcile,
  executeActions,
  type CatalogEntry,
  type ReconcilePlan,
} from "../../src/catalog/reconcile.js";
import type { InstalledMap } from "../../src/catalog/install.js";
import { lockFile as lockFilePathFromPaths } from "../../src/config/paths.js";
import { LockFileSchema } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// reconcile — pure logic tests (no mocks needed)
// ---------------------------------------------------------------------------

describe("reconcile", () => {
  // -----------------------------------------------------------------------
  // Empty inputs
  // -----------------------------------------------------------------------

  it("returns empty plan for empty catalog and empty installed", () => {
    const plan = reconcile({}, {});
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Install actions
  // -----------------------------------------------------------------------

  it("generates install action for catalog package not yet installed (npm)", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar" },
    };
    const plan = reconcile(catalog, {});
    expect(plan.installs).toHaveLength(1);
    expect(plan.installs[0]).toEqual({
      type: "install",
      key: "my-skill",
      source: "npm:@foo/bar",
    });
    expect(plan.uninstalls).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("generates install action for catalog entry with enabled: true explicit", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar", enabled: true },
    };
    const plan = reconcile(catalog, {});
    expect(plan.installs).toHaveLength(1);
    expect(plan.installs[0]).toEqual({
      type: "install",
      key: "my-skill",
      source: "npm:@foo/bar",
    });
  });

  it("generates install action for git source not yet installed", () => {
    const catalog: Record<string, CatalogEntry> = {
      "git-skill": { source: "git:github.com/user/repo" },
    };
    const plan = reconcile(catalog, {});
    expect(plan.installs).toHaveLength(1);
    expect(plan.installs[0].source).toBe("git:github.com/user/repo");
  });

  it("generates install action for local path not yet installed", () => {
    const catalog: Record<string, CatalogEntry> = {
      "local-skill": { source: "../../my/local-skill" },
    };
    const plan = reconcile(catalog, {});
    expect(plan.installs).toHaveLength(1);
    expect(plan.installs[0].source).toBe("../../my/local-skill");
  });

  // -----------------------------------------------------------------------
  // No action when already synced
  // -----------------------------------------------------------------------

  it("generates no actions when catalog package is already installed with same version", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar@1.0.0" },
    };
    const installed: InstalledMap = {
      "@foo/bar": {
        source: "npm:@foo/bar@1.0.0",
        name: "@foo/bar",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("generates no actions when catalog has no version pin and package is installed", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar" },
    };
    const installed: InstalledMap = {
      "@foo/bar": {
        source: "npm:@foo/bar@1.0.0",
        name: "@foo/bar",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.installs).toEqual([]);
    expect(plan.upgrades).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Uninstall actions (disabled packages)
  // -----------------------------------------------------------------------

  it("generates uninstall action for disabled package that is installed", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar", enabled: false },
    };
    const installed: InstalledMap = {
      "@foo/bar": {
        source: "npm:@foo/bar",
        name: "@foo/bar",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toHaveLength(1);
    expect(plan.uninstalls[0]).toEqual({
      type: "uninstall",
      key: "@foo/bar",
      source: "npm:@foo/bar",
    });
    expect(plan.upgrades).toEqual([]);
  });

  it("generates no action for disabled package that is not installed", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar", enabled: false },
    };
    const plan = reconcile(catalog, {});
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Upgrade actions
  // -----------------------------------------------------------------------

  it("generates upgrade action when catalog source specifies a newer version", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-skill": { source: "npm:@foo/bar@2.0.0" },
    };
    const installed: InstalledMap = {
      "@foo/bar": {
        source: "npm:@foo/bar@1.0.0",
        name: "@foo/bar",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]).toEqual({
      type: "upgrade",
      key: "@foo/bar",
      source: "npm:@foo/bar@2.0.0",
      currentVersion: "1.0.0",
      targetVersion: "2.0.0",
    });
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toEqual([]);
  });

  it("generates upgrade action for scoped package with version change", () => {
    const catalog: Record<string, CatalogEntry> = {
      skill: { source: "npm:@scope/pkg@5.0.0" },
    };
    const installed: InstalledMap = {
      "@scope/pkg": {
        source: "npm:@scope/pkg@3.0.0",
        name: "@scope/pkg",
        version: "3.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0].targetVersion).toBe("5.0.0");
    expect(plan.upgrades[0].currentVersion).toBe("3.0.0");
  });

  // -----------------------------------------------------------------------
  // Orphan detection
  // -----------------------------------------------------------------------

  it("detects orphan packages installed but not in catalog", () => {
    const installed: InstalledMap = {
      "orphan-pkg": {
        source: "npm:orphan-pkg",
        name: "orphan-pkg",
        version: "1.0.0",
      },
    };
    const plan = reconcile({}, installed);
    expect(plan.orphans).toHaveLength(1);
    expect(plan.orphans[0]).toEqual({
      key: "orphan-pkg",
      source: "npm:orphan-pkg",
      version: "1.0.0",
    });
    expect(plan.installs).toEqual([]);
    expect(plan.uninstalls).toEqual([]);
    expect(plan.upgrades).toEqual([]);
  });

  it("does not add orphans for packages that match catalog entries", () => {
    const catalog: Record<string, CatalogEntry> = {
      skill: { source: "npm:my-pkg" },
    };
    const installed: InstalledMap = {
      "my-pkg": { source: "npm:my-pkg", name: "my-pkg", version: "1.0.0" },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.orphans).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Orphan removal option
  // -----------------------------------------------------------------------

  it("generates uninstall actions for orphans when removeOrphans is true", () => {
    const installed: InstalledMap = {
      "orphan-a": {
        source: "npm:orphan-a",
        name: "orphan-a",
        version: "1.0.0",
      },
      "orphan-b": {
        source: "npm:orphan-b",
        name: "orphan-b",
        version: "2.0.0",
      },
    };
    const plan = reconcile({}, installed, { removeOrphans: true });
    expect(plan.orphans).toHaveLength(2);
    expect(plan.uninstalls).toHaveLength(2);
    const uninstallKeys = plan.uninstalls.map((a) => a.key);
    expect(uninstallKeys).toContain("orphan-a");
    expect(uninstallKeys).toContain("orphan-b");
  });

  it("does not generate uninstall for orphans by default", () => {
    const installed: InstalledMap = {
      "orphan-pkg": {
        source: "npm:orphan-pkg",
        name: "orphan-pkg",
        version: "1.0.0",
      },
    };
    const plan = reconcile({}, installed);
    expect(plan.orphans).toHaveLength(1);
    expect(plan.uninstalls).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Mixed scenarios
  // -----------------------------------------------------------------------

  it("handles multiple catalog entries with mixed scenarios", () => {
    const catalog: Record<string, CatalogEntry> = {
      "new-pkg": { source: "npm:new-pkg" },
      "disabled-pkg": { source: "npm:disabled-pkg", enabled: false },
      "existing-pkg": { source: "npm:existing-pkg" },
      "upgrade-pkg": { source: "npm:upgrade-pkg@3.0.0" },
    };
    const installed: InstalledMap = {
      "disabled-pkg": {
        source: "npm:disabled-pkg",
        name: "disabled-pkg",
        version: "1.0.0",
      },
      "existing-pkg": {
        source: "npm:existing-pkg",
        name: "existing-pkg",
        version: "1.0.0",
      },
      "upgrade-pkg": {
        source: "npm:upgrade-pkg@2.0.0",
        name: "upgrade-pkg",
        version: "2.0.0",
      },
      "orphan-pkg": {
        source: "npm:orphan-pkg",
        name: "orphan-pkg",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);

    expect(plan.installs).toHaveLength(1);
    expect(plan.installs[0].key).toBe("new-pkg");

    expect(plan.uninstalls).toHaveLength(1);
    expect(plan.uninstalls[0].key).toBe("disabled-pkg");

    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0].key).toBe("upgrade-pkg");
    expect(plan.upgrades[0].targetVersion).toBe("3.0.0");

    expect(plan.orphans).toHaveLength(1);
    expect(plan.orphans[0].key).toBe("orphan-pkg");
  });

  // -----------------------------------------------------------------------
  // Git source matching
  // -----------------------------------------------------------------------

  it("matches git sources by derived identity key", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-git": { source: "git:github.com/user/repo@v2" },
    };
    const installed: InstalledMap = {
      "github.com/user/repo": {
        source: "git:github.com/user/repo@v1",
        name: "github.com/user/repo",
        version: undefined,
      },
    };
    const plan = reconcile(catalog, installed);
    // Different source → treat as upgrade (version changed)
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0].source).toBe("git:github.com/user/repo@v2");
    expect(plan.installs).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("does not generate action for git source already installed with same ref", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-git": { source: "git:github.com/user/repo@v1" },
    };
    const installed: InstalledMap = {
      "github.com/user/repo": {
        source: "git:github.com/user/repo@v1",
        name: "github.com/user/repo",
        version: undefined,
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.installs).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Local path matching
  // -----------------------------------------------------------------------

  it("matches local path packages by raw source string", () => {
    const catalog: Record<string, CatalogEntry> = {
      "my-local": { source: "../../my/local-skill" },
    };
    const installed: InstalledMap = {
      "../../my/local-skill": {
        source: "../../my/local-skill",
        name: "local-skill",
        version: "1.0.0",
      },
    };
    const plan = reconcile(catalog, installed);
    expect(plan.installs).toEqual([]);
    expect(plan.upgrades).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeActions — mocked shell execution
// ---------------------------------------------------------------------------

vi.mock("../../src/util/exec.js", () => ({
  piInstall: vi.fn(),
  piUninstall: vi.fn(),
}));

import { piInstall, piUninstall } from "../../src/util/exec.js";

const mockedPiInstall = vi.mocked(piInstall);
const mockedPiUninstall = vi.mocked(piUninstall);

let writtenLock: { path: string; content: string } | null;
const mockLockWriter = vi.fn((filePath: string, content: string) => {
  writtenLock = { path: filePath, content };
});

describe("executeActions", () => {

  beforeEach(() => {
    mockedPiInstall.mockReset();
    mockedPiUninstall.mockReset();
    mockLockWriter.mockClear();
    writtenLock = null;
    // Default: resolve all operations
    mockedPiInstall.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockedPiUninstall.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes install actions via piInstall", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
        { type: "install", key: "pkg-b", source: "git:github.com/user/repo" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockedPiInstall).toHaveBeenCalledTimes(2);
    expect(mockedPiInstall).toHaveBeenCalledWith("npm:pkg-a");
    expect(mockedPiInstall).toHaveBeenCalledWith(
      "git:github.com/user/repo",
    );
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("executes uninstall actions via piUninstall", async () => {
    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [
        { type: "uninstall", key: "old-pkg", source: "npm:old-pkg" },
      ],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockedPiUninstall).toHaveBeenCalledTimes(1);
    expect(mockedPiUninstall).toHaveBeenCalledWith(
      "old-pkg",
    );
    expect(result.success).toBe(true);
  });

  it("executes upgrade actions as install (reinstall)", async () => {
    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [],
      upgrades: [
        {
          type: "upgrade",
          key: "pkg-a",
          source: "npm:pkg-a@2.0.0",
          currentVersion: "1.0.0",
          targetVersion: "2.0.0",
        },
      ],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    // Upgrades run piInstall with the new source
    expect(mockedPiInstall).toHaveBeenCalledTimes(1);
    expect(mockedPiInstall).toHaveBeenCalledWith(
      "npm:pkg-a@2.0.0",
    );
    expect(result.success).toBe(true);
  });

  it("returns error results when an action fails", async () => {
    const execError = new Error("install failed");
    mockedPiInstall.mockRejectedValueOnce(execError);

    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].action.key).toBe("bad-pkg");
    expect(result.errors[0].error).toBe(execError);
  });

  it("continues executing remaining actions after a failure", async () => {
    mockedPiInstall.mockRejectedValueOnce(new Error("fail"));

    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
        { type: "install", key: "good-pkg", source: "npm:good-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockedPiInstall).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].action.key).toBe("bad-pkg");
  });

  it("returns success with no operations for empty plan", async () => {
    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan);

    expect(result.success).toBe(true);
    expect(mockedPiInstall).not.toHaveBeenCalled();
    expect(mockedPiUninstall).not.toHaveBeenCalled();
  });

  it("writes lock file after successful execution", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockLockWriter).toHaveBeenCalled();
    expect(writtenLock).not.toBeNull();
    expect(writtenLock!.path).toContain("catalog.lock.json");
    const parsed = JSON.parse(writtenLock!.content);
    expect(parsed).toHaveProperty("packages");
  });

  it("uses lockFile path from paths.ts when home is provided", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { home: "/tmp/test-home", lockFileWriter: mockLockWriter });

    expect(writtenLock).not.toBeNull();
    expect(writtenLock!.path).toBe(lockFilePathFromPaths("/tmp/test-home"));
  });

  it("uses lockFile path from paths.ts with os.homedir() when home is omitted", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(writtenLock).not.toBeNull();
    expect(writtenLock!.path).toBe(lockFilePathFromPaths());
  });

  it("writes lock file content that matches LockFileSchema (no updatedAt)", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(writtenLock).not.toBeNull();
    const parsed = JSON.parse(writtenLock!.content);
    // Must not contain updatedAt — the schema has no such field
    expect(parsed).not.toHaveProperty("updatedAt");
    // Must validate cleanly against the schema
    expect(() => LockFileSchema.parse(parsed)).not.toThrow();
  });

  it("does not write lock file when there are errors", async () => {
    mockedPiInstall.mockRejectedValueOnce(new Error("fail"));

    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockLockWriter).not.toHaveBeenCalled();
  });

  it("does not write lock file for empty plan with no actions", async () => {
    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(mockLockWriter).not.toHaveBeenCalled();
  });

  it("returns error when uninstall action fails", async () => {
    const uninstallError = new Error("uninstall failed");
    mockedPiUninstall.mockRejectedValueOnce(uninstallError);

    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [
        { type: "uninstall", key: "old-pkg", source: "npm:old-pkg" },
      ],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].action.type).toBe("uninstall");
    expect(result.errors[0].action.key).toBe("old-pkg");
    expect(result.errors[0].error).toBe(uninstallError);
  });

  it("returns error when upgrade action fails", async () => {
    const upgradeError = new Error("upgrade failed");
    mockedPiInstall.mockRejectedValueOnce(upgradeError);

    const plan: ReconcilePlan = {
      installs: [],
      uninstalls: [],
      upgrades: [
        {
          type: "upgrade",
          key: "pkg-a",
          source: "npm:pkg-a@2.0.0",
          currentVersion: "1.0.0",
          targetVersion: "2.0.0",
        },
      ],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].action.type).toBe("upgrade");
    expect(result.errors[0].action.key).toBe("pkg-a");
    expect(result.errors[0].error).toBe(upgradeError);
  });

  it("executes actions in order: uninstalls → installs → upgrades", async () => {
    const callOrder: string[] = [];
    mockedPiUninstall.mockImplementation(async () => {
      callOrder.push("uninstall");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    mockedPiInstall.mockImplementation(async (source: string) => {
      callOrder.push(source.startsWith("npm:upgrade") ? "upgrade" : "install");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "new-pkg", source: "npm:new-pkg" },
      ],
      uninstalls: [
        { type: "uninstall", key: "old-pkg", source: "npm:old-pkg" },
      ],
      upgrades: [
        {
          type: "upgrade",
          key: "upgrade-pkg",
          source: "npm:upgrade-pkg@2.0.0",
          currentVersion: "1.0.0",
          targetVersion: "2.0.0",
        },
      ],
      orphans: [],
    };

    await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(callOrder).toEqual(["uninstall", "install", "upgrade"]);
  });

  it("dryRun skips all shell execution and does not write lock file", async () => {
    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "pkg-a", source: "npm:pkg-a" },
      ],
      uninstalls: [
        { type: "uninstall", key: "old-pkg", source: "npm:old-pkg" },
      ],
      upgrades: [
        {
          type: "upgrade",
          key: "upgrade-pkg",
          source: "npm:upgrade-pkg@2.0.0",
          currentVersion: "1.0.0",
          targetVersion: "2.0.0",
        },
      ],
      orphans: [],
    };

    const result = await executeActions(plan, {
      dryRun: true,
      lockFileWriter: mockLockWriter,
    });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockedPiInstall).not.toHaveBeenCalled();
    expect(mockedPiUninstall).not.toHaveBeenCalled();
    expect(mockLockWriter).not.toHaveBeenCalled();
  });

  it("handles non-Error rejections from piInstall", async () => {
    mockedPiInstall.mockRejectedValueOnce("string error");

    const plan: ReconcilePlan = {
      installs: [
        { type: "install", key: "bad-pkg", source: "npm:bad-pkg" },
      ],
      uninstalls: [],
      upgrades: [],
      orphans: [],
    };

    const result = await executeActions(plan, { lockFileWriter: mockLockWriter });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error.message).toBe("string error");
  });
});
