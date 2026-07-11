import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import { resetCommand, type ResetCtx } from "../../src/commands/reset.js";
import { writeCatalog } from "../../src/config/io.js";
import { catalogDir, catalogFile, lockFile } from "../../src/config/paths.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-reset-"));
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

function makeCtx(): {
  ctx: ResetCtx;
  ui: { notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };
} {
  const ui = {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
  };
  return { ctx: { ui, home: tmpDir } as unknown as ResetCtx, ui };
}

function catalogWithPiStef(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "@pi-stef/figma": { source: "npm:@pi-stef/figma" },
      "@pi-stef/web": { source: "npm:@pi-stef/web" },
      "other-pkg": { source: "npm:other-pkg" },
      "@pi-stef/catalog": { source: "npm:@pi-stef/catalog" },
    },
  };
}

// ---------------------------------------------------------------------------
// resetCommand
// ---------------------------------------------------------------------------

describe("resetCommand", () => {
  let uninstallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../../src/util/exec.js");
    uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    uninstallSpy?.mockRestore();
    cleanup();
  });

  // --- Error cases ----------------------------------------------------------

  it("shows error when no catalog exists", async () => {
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No catalog found"),
      "error",
    );
  });

  // --- Confirmation ---------------------------------------------------------

  it("prompts for confirmation before resetting", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: {} }, ctx);

    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining("@pi-stef"),
    );
  });

  it("does not reset when user declines confirmation", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(false);

    await resetCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
      "info",
    );
    // Config files should still exist
    expect(fs.existsSync(catalogFile(tmpDir))).toBe(true);
  });

  it("skips confirmation with --yes flag", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    expect(ui.confirm).not.toHaveBeenCalled();
  });

  // --- Uninstall -----------------------------------------------------------

  it("uninstalls @pi-stef packages (excluding catalog)", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    // Should uninstall 2 @pi-stef packages (figma, web), not catalog or other-pkg
    expect(uninstallSpy).toHaveBeenCalledTimes(2);
    expect(uninstallSpy).toHaveBeenCalledWith("npm:@pi-stef/figma");
    expect(uninstallSpy).toHaveBeenCalledWith("npm:@pi-stef/web");
  });

  // --- Config deletion -----------------------------------------------------

  it("deletes config files and catalog directory", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);

    // Also create a .gist file
    const dir = catalogDir(tmpDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".gist"), "test-gist-id");

    const { ctx } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    // Config files should be deleted
    expect(fs.existsSync(catalogFile(tmpDir))).toBe(false);
    expect(fs.existsSync(lockFile(tmpDir))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gist"))).toBe(false);
    // Directory itself should be removed
    expect(fs.existsSync(dir)).toBe(false);
  });

  // --- Summary report -------------------------------------------------------

  it("reports uninstall summary", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("uninstalled 2/2"),
      "info",
    );
  });

  it("warns when some uninstalls fail", async () => {
    writeCatalog(catalogWithPiStef(), tmpDir);
    const { ctx, ui } = makeCtx();

    uninstallSpy
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(new Error("uninstall failed"));

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("1 uninstall failed"),
      "warning",
    );
  });
});
