import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { initCommand } from "../../src/commands/init.js";
import type { CatalogYaml } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock scanInstalled so we don't need real settings.json on disk
vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

// Mock gist reader so we don't need real network calls
vi.mock("../../src/sync/gist.js", () => ({
  readGist: vi.fn(),
}));

import { scanInstalled } from "../../src/catalog/install.js";
import { readGist } from "../../src/sync/gist.js";

const mockedScan = vi.mocked(scanInstalled);
const mockedReadGist = vi.mocked(readGist);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const notifications: Array<{ msg: string; type?: string }> = [];
const errors: Array<{ msg: string; type?: string }> = [];

function makeCtx() {
  notifications.length = 0;
  errors.length = 0;
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn((msg: string, type?: "error" | "info" | "warning") => {
        if (type === "error") {
          errors.push({ msg, type });
        } else {
          notifications.push({ msg, type });
        }
      }),
    },
  };
}

function readCatalogFromDisk(): CatalogYaml {
  const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw) as CatalogYaml;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-init-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty system → empty catalog
  // -------------------------------------------------------------------------

  it("generates an empty catalog when no packages are installed", async () => {
    mockedScan.mockReturnValue({});

    await initCommand([], makeCtx());

    const catalog = readCatalogFromDisk();
    expect(catalog.meta.pi_version).toBe("0.0.0");
    expect(catalog.packages).toEqual({});
  });

  // -------------------------------------------------------------------------
  // System with installed packages → catalog with entries
  // -------------------------------------------------------------------------

  it("generates catalog entries from installed packages with core rating", async () => {
    mockedScan.mockReturnValue({
      "my-skill": { source: "npm:my-skill", name: "my-skill", version: "1.0.0" },
      "another-pkg": { source: "git:github.com/user/repo", name: "github.com/user/repo", version: undefined },
    });

    await initCommand([], makeCtx());

    const catalog = readCatalogFromDisk();
    expect(Object.keys(catalog.packages)).toHaveLength(2);
    expect(catalog.packages["my-skill"]).toEqual({
      source: "npm:my-skill",
      rating: "core",
    });
    expect(catalog.packages["another-pkg"]).toEqual({
      source: "git:github.com/user/repo",
      rating: "core",
    });
  });

  // -------------------------------------------------------------------------
  // Overwrites existing catalog
  // -------------------------------------------------------------------------

  it("overwrites an existing cat.yaml on disk", async () => {
    mockedScan.mockReturnValue({});

    // Write a pre-existing catalog
    const dir = path.join(tmpDir, ".pi", "sf", "catalog");
    fs.mkdirSync(dir, { recursive: true });
    const existing: CatalogYaml = {
      meta: { pi_version: "9.9.9" },
      packages: { "old-pkg": { source: "npm:old", rating: "useful" } },
    };
    fs.writeFileSync(path.join(dir, "cat.yaml"), yaml.dump(existing), "utf-8");

    mockedScan.mockReturnValue({
      "new-pkg": { source: "npm:new-pkg", name: "new-pkg", version: "2.0.0" },
    });

    await initCommand([], makeCtx());

    const catalog = readCatalogFromDisk();
    expect(catalog.packages["old-pkg"]).toBeUndefined();
    expect(catalog.packages["new-pkg"]).toEqual({
      source: "npm:new-pkg",
      rating: "core",
    });
  });

  // -------------------------------------------------------------------------
  // User feedback via ctx.ui.notify
  // -------------------------------------------------------------------------

  it("notifies the user after successful init", async () => {
    mockedScan.mockReturnValue({
      "a": { source: "npm:a", name: "a", version: "1.0.0" },
    });

    const ctx = makeCtx();
    await initCommand([], ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();
    const call = ctx.ui.notify.mock.calls.find(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("1"),
    );
    expect(call).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // --from-gist fetches and imports catalog from gist
  // -------------------------------------------------------------------------

  describe("--from-gist", () => {
    it("fetches gist content and writes it as catalog", async () => {
      const gistCatalog: CatalogYaml = {
        meta: { pi_version: "3.5.0" },
        packages: {
          "remote-skill": {
            source: "npm:remote-skill",
            rating: "useful",
            type: "skill",
          },
        },
      };

      mockedReadGist.mockResolvedValue({
        id: "abc123",
        files: {
          "cat.yaml": { content: yaml.dump(gistCatalog) },
        },
      });

      const ctx = makeCtx();
      await initCommand(["--from-gist=abc123"], ctx);

      const catalog = readCatalogFromDisk();
      expect(catalog.meta.pi_version).toBe("3.5.0");
      expect(catalog.packages["remote-skill"]).toEqual({
        source: "npm:remote-skill",
        rating: "useful",
        type: "skill",
      });
    });

    it("notifies the user after gist import", async () => {
      const gistCatalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {},
      };

      mockedReadGist.mockResolvedValue({
        id: "xyz789",
        files: {
          "cat.yaml": { content: yaml.dump(gistCatalog) },
        },
      });

      const ctx = makeCtx();
      await initCommand(["--from-gist=xyz789"], ctx);

      expect(ctx.ui.notify).toHaveBeenCalled();
    });

    it("notifies error when gist fetch fails", async () => {
      mockedReadGist.mockRejectedValue(new Error("Gist not found"));

      const ctx = makeCtx();
      await initCommand(["--from-gist=bad-id"], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Gist not found"),
        "error",
      );
    });

    it("notifies error when gist has no cat.yaml file", async () => {
      mockedReadGist.mockResolvedValue({
        id: "abc123",
        files: {},
      });

      const ctx = makeCtx();
      await initCommand(["--from-gist=abc123"], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("cat.yaml"),
        "error",
      );
    });
  });
});
