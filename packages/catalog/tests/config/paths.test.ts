import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { catalogDir, catalogFile, lockFile, ensureCatalogDir, npmNodeModulesDir } from "../../src/config/paths.js";

const HOME = "/tmp/pi-catalog-paths-test";

describe("catalog path resolution", () => {
  it("catalogDir returns ~/.pi/sf/catalog/", () => {
    expect(catalogDir(HOME)).toBe(path.join(HOME, ".pi", "sf", "catalog"));
  });

  it("catalogFile returns ~/.pi/sf/catalog/cat.yaml", () => {
    expect(catalogFile(HOME)).toBe(path.join(HOME, ".pi", "sf", "catalog", "cat.yaml"));
  });

  it("lockFile returns ~/.pi/sf/catalog/catalog.lock.json", () => {
    expect(lockFile(HOME)).toBe(path.join(HOME, ".pi", "sf", "catalog", "catalog.lock.json"));
  });

  it("defaults to os.homedir() when home is omitted", () => {
    const dir = catalogDir();
    expect(dir).toContain(".pi");
    expect(dir).toContain("sf");
    expect(dir).toContain("catalog");
    expect(dir).toBe(path.join(os.homedir(), ".pi", "sf", "catalog"));
  });

  it("npmNodeModulesDir returns ~/.pi/agent/npm/node_modules", () => {
    expect(npmNodeModulesDir(HOME)).toBe(
      path.join(HOME, ".pi", "agent", "npm", "node_modules"),
    );
  });

  it("npmNodeModulesDir defaults to os.homedir() when home is omitted", () => {
    expect(npmNodeModulesDir()).toBe(
      path.join(os.homedir(), ".pi", "agent", "npm", "node_modules"),
    );
  });
});

describe("ensureCatalogDir", () => {
  afterEach(() => {
    // Clean up test directory
    fs.rmSync(path.join(HOME, ".pi"), { recursive: true, force: true });
  });

  it("creates the catalog directory if it does not exist", () => {
    const dir = catalogDir(HOME);
    expect(fs.existsSync(dir)).toBe(false);

    ensureCatalogDir(HOME);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("is a no-op when the directory already exists", () => {
    const dir = catalogDir(HOME);
    fs.mkdirSync(dir, { recursive: true });

    // Should not throw
    ensureCatalogDir(HOME);

    expect(fs.existsSync(dir)).toBe(true);
  });
});
