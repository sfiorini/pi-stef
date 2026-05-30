import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import { writeCatalog, readCatalog } from "../../src/config/io.js";
import {
  toggleCommand,
  enableCommand,
  disableCommand,
} from "../../src/commands/toggle.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-toggle-"));
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
}

function makeCtx(overrides: Partial<MockUi> = {}): {
  ctx: { ui: MockUi; home: string };
  ui: MockUi;
} {
  const ui: MockUi = {
    notify: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir }, ui };
}

function catalogWith(
  packages: CatalogYaml["packages"],
): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages,
  };
}

function seedCatalog(home: string, packages: CatalogYaml["packages"]): void {
  writeCatalog(catalogWith(packages), home);
}

// ---------------------------------------------------------------------------
// toggleCommand
// ---------------------------------------------------------------------------

describe("toggleCommand", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("cycles rating: core → useful", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
    });
    const { ctx, ui } = makeCtx();

    await toggleCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("useful");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("useful"),
      "info",
    );
  });

  it("cycles rating: useful → debatable", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "useful" },
    });
    const { ctx } = makeCtx();

    await toggleCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("debatable");
  });

  it("cycles rating: debatable → disabled", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "debatable" },
    });
    const { ctx } = makeCtx();

    await toggleCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("disabled");
  });

  it("cycles rating: disabled → core", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "disabled" },
    });
    const { ctx } = makeCtx();

    await toggleCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("core");
  });

  it("shows error when package not found", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await toggleCommand({ positional: ["nonexistent"], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
  });

  it("shows error when no package name given", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await toggleCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });
});

// ---------------------------------------------------------------------------
// enableCommand
// ---------------------------------------------------------------------------

describe("enableCommand", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("enables a disabled package, restoring to core when no previous rating", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "disabled" },
    });
    const { ctx, ui } = makeCtx();

    await enableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("core");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Enabled"),
      "info",
    );
  });

  it("restores previous rating when enabling a disabled package", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": {
        source: "npm:my-pkg",
        rating: "disabled",
        previousRating: "useful",
      },
    });
    const { ctx } = makeCtx();

    await enableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("useful");
    expect(catalog.packages["my-pkg"].previousRating).toBeUndefined();
  });

  it("is a no-op for already-enabled package", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
    });
    const { ctx, ui } = makeCtx();

    await enableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("core");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already"),
      "info",
    );
  });

  it("shows error when package not found", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await enableCommand({ positional: ["nonexistent"], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
  });

  it("shows error when no package name given", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await enableCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });
});

// ---------------------------------------------------------------------------
// disableCommand
// ---------------------------------------------------------------------------

describe("disableCommand", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("sets rating to disabled and saves previous rating", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "useful" },
    });
    const { ctx, ui } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await disableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("disabled");
    expect(catalog.packages["my-pkg"].previousRating).toBe("useful");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disabled"),
      "info",
    );
    uninstallSpy.mockRestore();
  });

  it("runs pi uninstall after disabling", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
    });
    const { ctx } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await disableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    expect(uninstallSpy).toHaveBeenCalledWith("my-pkg");
    uninstallSpy.mockRestore();
  });

  it("warns when pi uninstall fails", async () => {
    seedCatalog(tmpDir, {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
    });
    const { ctx, ui } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockRejectedValue(new Error("uninstall failed"));

    await disableCommand({ positional: ["my-pkg"], flags: {} }, ctx);

    // Catalog should still be updated
    const catalog = readCatalog(tmpDir);
    expect(catalog.packages["my-pkg"].rating).toBe("disabled");

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("uninstall"),
      "warning",
    );
    uninstallSpy.mockRestore();
  });

  it("shows error when package not found", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await disableCommand({ positional: ["nonexistent"], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
  });

  it("shows error when no package name given", async () => {
    seedCatalog(tmpDir, {});
    const { ctx, ui } = makeCtx();

    await disableCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });
});
