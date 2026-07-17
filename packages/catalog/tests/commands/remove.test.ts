import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import type { CommandCtx } from "../../src/commands/types.js";
import { removeCommand } from "../../src/commands/remove.js";
import { writeCatalog, readCatalog } from "../../src/config/io.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-remove-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Mock ctx builder
// ---------------------------------------------------------------------------

interface MockUi {
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<MockUi> = {}): {
  ctx: CommandCtx;
  ui: MockUi;
} {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir } as CommandCtx, ui };
}

function catalogWithPackages(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-pkg": { source: "npm:my-pkg" },
      "another-pkg": {
        source: "git:github.com/user/repo#packages/another-pkg",
        type: "skill",
      },
    },
  };
}

function seedCatalog(home: string, catalog?: CatalogYaml): void {
  writeCatalog(catalog ?? catalogWithPackages(), home);
}

// ---------------------------------------------------------------------------
// removeCommand
// ---------------------------------------------------------------------------

describe("removeCommand", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  // --- Removes existing package and writes catalog --------------------------

  it("removes an existing package from the catalog", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeUndefined();
    // The other package should still be there
    expect(catalog.packages["another-pkg"]).toBeDefined();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      "info",
    );
    uninstallSpy.mockRestore();
  });

  // --- Missing package shows error ------------------------------------------

  it("shows error when package does not exist", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await removeCommand(
      { positional: ["nonexistent"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );

    // Catalog should be unchanged
    const catalog = readCatalog(tmpDir);
    expect(Object.keys(catalog.packages)).toHaveLength(2);
  });

  // --- Confirms before removing ---------------------------------------------

  it("prompts for confirmation before removing", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      expect.any(String),
    );
    uninstallSpy.mockRestore();
  });

  // --- User declines confirmation, no removal ------------------------------

  it("does not remove when user declines confirmation", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(false);

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeDefined();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
      "info",
    );
  });

  // --- Runs pi uninstall after removal --------------------------------------

  it("runs pi uninstall after successful removal", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(uninstallSpy).toHaveBeenCalledWith("npm:my-pkg");
    uninstallSpy.mockRestore();
  });

  // --- Uninstall failure is non-fatal ---------------------------------------

  it("notifies on uninstall failure but still removes from catalog", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockRejectedValue(new Error("uninstall failed"));

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    // Catalog should still be updated
    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeUndefined();
    // But user should be warned
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("uninstall"),
      "warning",
    );
    uninstallSpy.mockRestore();
  });

  // --- Missing positional arg shows usage -----------------------------------

  it("shows error when no package name is provided", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await removeCommand(
      { positional: [], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  // --- --yes flag skips confirmation ----------------------------------------

  it("skips confirmation when --yes flag is provided", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: { yes: true } },
      ctx,
    );

    expect(ui.confirm).not.toHaveBeenCalled();
    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeUndefined();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      "info",
    );
    uninstallSpy.mockRestore();
  });

  // --- Reload behavior -------------------------------------------------------

  it("calls ctx.reload after successful uninstall", async () => {
    seedCatalog(tmpDir);
    const reload = vi.fn().mockResolvedValue(undefined);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);
    (ctx as any).reload = reload;

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(reload).toHaveBeenCalled();
    uninstallSpy.mockRestore();
  });

  it("shows restart message when ctx.reload is absent", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Restart pi"),
      "warning",
    );
    uninstallSpy.mockRestore();
  });

  it("does not call ctx.reload when uninstall fails", async () => {
    seedCatalog(tmpDir);
    const reload = vi.fn().mockResolvedValue(undefined);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);
    (ctx as any).reload = reload;

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockRejectedValue(new Error("uninstall failed"));

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(reload).not.toHaveBeenCalled();
    uninstallSpy.mockRestore();
  });

  // =========================================================================
  // --scope @pi-stef batch mode
  // =========================================================================

  describe("--scope @pi-stef", () => {
    function catalogWithPiStef(): CatalogYaml {
      return {
        meta: { pi_version: "1.0.0" },
        packages: {
          "@pi-stef/figma": { source: "npm:@pi-stef/figma" },
          "@pi-stef/web": { source: "npm:@pi-stef/web" },
          "other-pkg": { source: "npm:other-pkg" },
          // Catalog itself — should NOT be removed
          "@pi-stef/catalog": { source: "npm:@pi-stef/catalog" },
        },
      };
    }

    it("removes all @pi-stef packages (excluding catalog)", async () => {
      seedCatalog(tmpDir, catalogWithPiStef());
      const { ctx, ui } = makeCtx();
      ui.confirm.mockResolvedValue(true);

      const execModule = await import("../../src/util/exec.js");
      const uninstallSpy = vi
        .spyOn(execModule, "piUninstall")
        .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await removeCommand(
        { positional: [], flags: { scope: "@pi-stef" } },
        ctx,
      );

      const catalog = readCatalog(tmpDir);
      // @pi-stef packages removed
      expect(catalog.packages["@pi-stef/figma"]).toBeUndefined();
      expect(catalog.packages["@pi-stef/web"]).toBeUndefined();
      // Non-pi-stef package untouched
      expect(catalog.packages["other-pkg"]).toBeDefined();
      // Catalog package untouched
      expect(catalog.packages["@pi-stef/catalog"]).toBeDefined();

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("removed 2"),
        "info",
      );
      expect(uninstallSpy).toHaveBeenCalledTimes(2);
      uninstallSpy.mockRestore();
    });

    it("prompts for confirmation before removing", async () => {
      seedCatalog(tmpDir, catalogWithPiStef());
      const { ctx, ui } = makeCtx();

      const execModule = await import("../../src/util/exec.js");
      const uninstallSpy = vi
        .spyOn(execModule, "piUninstall")
        .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await removeCommand(
        { positional: [], flags: { scope: "@pi-stef" } },
        ctx,
      );

      expect(ui.confirm).toHaveBeenCalledWith(
        expect.stringContaining("@pi-stef"),
        expect.any(String),
      );
      uninstallSpy.mockRestore();
    });

    it("shows info when no @pi-stef packages in catalog", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await removeCommand(
        { positional: [], flags: { scope: "@pi-stef" } },
        ctx,
      );

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No @pi-stef packages"),
        "info",
      );
    });

    it("rejects unsupported scope", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await removeCommand(
        { positional: [], flags: { scope: "@other" } },
        ctx,
      );

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported scope"),
        "error",
      );
    });
  });
});
