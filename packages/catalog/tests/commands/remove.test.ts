import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
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
  ctx: { ui: MockUi; home: string };
  ui: MockUi;
} {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir }, ui };
}

function catalogWithPackages(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
      "another-pkg": {
        source: "git:github.com/user/repo#packages/another-pkg",
        rating: "useful",
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
    ui.confirm.mockResolvedValue(true);

    await removeCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
    );
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

    expect(uninstallSpy).toHaveBeenCalledWith("my-pkg");
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
  });
});
