import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import type { CommandCtx } from "../../src/commands/types.js";
import { addCommand } from "../../src/commands/add.js";
import { writeCatalog, readCatalog } from "../../src/config/io.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-add-"));
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

function emptyCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {},
  };
}

function seedCatalog(home: string, catalog?: CatalogYaml): void {
  writeCatalog(catalog ?? emptyCatalog(), home);
}

// ---------------------------------------------------------------------------
// addCommand
// ---------------------------------------------------------------------------

describe("addCommand", () => {
  let installSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../../src/util/exec.js");
    installSpy = vi
      .spyOn(execModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    installSpy?.mockRestore();
    cleanup();
  });

  // --- Full args, npm source ------------------------------------------------

  it("adds a package with full args and npm source", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: ["my-pkg", "npm:my-pkg"], flags: {} },
      ctx,
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toEqual({
      source: "npm:my-pkg",
    });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      "info",
    );
  });

  // --- Full args, git source with -s flag -----------------------------------

  it("adds a package with git source and explicit -s/--type flag", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      {
        positional: ["my-pkg", "git:github.com/sfiorini/pi-stef#packages/my-pkg"],
        flags: { type: "skill" },
      },
      ctx,
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toEqual({
      source: "git:github.com/sfiorini/pi-stef#packages/my-pkg",
      type: "skill",
    });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      "info",
    );
  });

  // --- Git source without -s prompts for type -------------------------------

  it("prompts for type when git source and no -s flag", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.select.mockResolvedValue("pi-native");

    await addCommand(
      {
        positional: ["my-pkg", "git:github.com/user/repo"],
        flags: {},
      },
      ctx,
    );

    expect(ui.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("type"),
      }),
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toEqual({
      source: "git:github.com/user/repo",
      type: "pi-native",
    });
  });

  // --- NPM source does not prompt for type ----------------------------------

  it("does not prompt for type when npm source", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      {
        positional: ["my-pkg", "npm:my-pkg"],
        flags: {},
      },
      ctx,
    );

    expect(ui.select).not.toHaveBeenCalled();

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].type).toBeUndefined();
  });

  // --- Duplicate name shows error -------------------------------------------

  it("shows error when package name already exists", async () => {
    const existing: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "my-pkg": { source: "npm:existing" },
      },
    };
    seedCatalog(tmpDir, existing);
    const { ctx, ui } = makeCtx();

    await addCommand(
      {
        positional: ["my-pkg", "npm:another"],
        flags: {},
      },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "error",
    );

    // Catalog should be unchanged
    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].source).toBe("npm:existing");
  });

  // --- Invalid source shows error -------------------------------------------

  it("shows error for invalid source format", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      {
        positional: ["my-pkg", "invalid-source"],
        flags: {},
      },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid source"),
      "error",
    );

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeUndefined();
  });

  // --- Missing positional args ----------------------------------------------

  it("shows error when no args provided", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: [], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  it("shows error for invalid source when single positional arg", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid source"),
      "error",
    );
  });

  // --- Runs pi install after adding -----------------------------------------

  it("runs pi install after adding a package", async () => {
    seedCatalog(tmpDir);
    const { ctx } = makeCtx();

    await addCommand(
      {
        positional: ["my-pkg", "npm:my-pkg"],
        flags: {},
      },
      ctx,
    );

    expect(installSpy).toHaveBeenCalledWith("npm:my-pkg");
  });

  // --- Reload behavior -------------------------------------------------------

  it("calls ctx.reload after successful install", async () => {
    seedCatalog(tmpDir);
    const reload = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx();
    (ctx as any).reload = reload;

    await addCommand(
      { positional: ["my-pkg", "npm:my-pkg"], flags: {} },
      ctx,
    );

    expect(reload).toHaveBeenCalled();
  });

  it("shows restart message when ctx.reload is absent", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: ["my-pkg", "npm:my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Restart pi"),
      "warning",
    );
  });

  it("does not call ctx.reload when install fails", async () => {
    seedCatalog(tmpDir);
    const reload = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx();
    (ctx as any).reload = reload;

    installSpy.mockRejectedValue(new Error("install failed"));

    await addCommand(
      { positional: ["my-pkg", "npm:my-pkg"], flags: {} },
      ctx,
    );

    expect(reload).not.toHaveBeenCalled();
  });

  // --- install failure is non-fatal -----------------------------------------

  it("notifies on install failure but still writes catalog", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    installSpy.mockRejectedValue(new Error("install failed"));

    await addCommand(
      {
        positional: ["my-pkg", "npm:my-pkg"],
        flags: {},
      },
      ctx,
    );

    // Catalog should still be written
    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"]).toBeDefined();
    // But user should be warned about the install failure
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("install"),
      "warning",
    );
  });

  // =========================================================================
  // Auto-derived name (new syntax: ct add <source>)
  // =========================================================================

  describe("auto-derived name from source", () => {
    it("derives name from npm source", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await addCommand(
        { positional: ["npm:@scope/my-pkg@1.0.0"], flags: {} },
        ctx,
      );

      const catalog = readCatalog(tmpDir);
      expect(catalog.packages["@scope/my-pkg"]).toEqual({
        source: "npm:@scope/my-pkg@1.0.0",
      });
      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("@scope/my-pkg"),
        "info",
      );
    });

    it("derives name from git source", async () => {
      seedCatalog(tmpDir);
      const { ctx } = makeCtx();

      await addCommand(
        {
          positional: ["git:github.com/user/repo#packages/foo"],
          flags: { type: "skill" },
        },
        ctx,
      );

      const catalog = readCatalog(tmpDir);
      expect(catalog.packages["github.com/user/repo#packages/foo"]).toEqual({
        source: "git:github.com/user/repo#packages/foo",
        type: "skill",
      });
    });

    it("shows no deprecation warning for new syntax", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await addCommand(
        { positional: ["npm:my-pkg"], flags: {} },
        ctx,
      );

      expect(ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("legacy"),
        "warning",
      );
    });
  });

  // =========================================================================
  // Legacy 2-arg syntax
  // =========================================================================

  describe("legacy 2-arg syntax", () => {
    it("still works but shows deprecation warning", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await addCommand(
        { positional: ["my-pkg", "npm:my-pkg"], flags: {} },
        ctx,
      );

      // Deprecation warning emitted
      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("legacy"),
        "warning",
      );

      // Package still added with user-supplied name
      const catalog = readCatalog(tmpDir);
      expect(catalog.packages["my-pkg"]).toEqual({
        source: "npm:my-pkg",
      });
    });
  });

  // =========================================================================
  // --scope @pi-stef batch mode
  // =========================================================================

  describe("--scope @pi-stef", () => {
    it("adds all @pi-stef packages to catalog", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await addCommand(
        { positional: [], flags: { scope: "@pi-stef" } },
        ctx,
      );

      const catalog = readCatalog(tmpDir);
      expect(catalog.packages["@pi-stef/agent-workflows"]).toBeDefined();
      expect(catalog.packages["@pi-stef/atlassian"]).toBeDefined();
      expect(catalog.packages["@pi-stef/figma"]).toBeDefined();
      expect(catalog.packages["@pi-stef/flow"]).toBeDefined();
      expect(catalog.packages["@pi-stef/paths"]).toBeDefined();
      expect(catalog.packages["@pi-stef/team"]).toBeDefined();
      expect(catalog.packages["@pi-stef/web"]).toBeDefined();

      // Catalog package itself should NOT be added
      expect(catalog.packages["@pi-stef/catalog"]).toBeUndefined();

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("added 8"),
        "info",
      );
    });

    it("skips packages already in catalog", async () => {
      const existing = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "@pi-stef/figma": { source: "npm:@pi-stef/figma" },
        },
      };
      seedCatalog(tmpDir, existing);
      const { ctx, ui } = makeCtx();

      await addCommand(
        { positional: [], flags: { scope: "@pi-stef" } },
        ctx,
      );

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("skipped 1"),
        "info",
      );
    });

    it("rejects unsupported scope", async () => {
      seedCatalog(tmpDir);
      const { ctx, ui } = makeCtx();

      await addCommand(
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
