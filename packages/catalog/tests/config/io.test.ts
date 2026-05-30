import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  readCatalog,
  writeCatalog,
  readLock,
  writeLock,
} from "../../src/config/io.js";
import { CatalogYamlSchema, LockFileSchema } from "../../src/config/schema.js";
import type { CatalogYaml, LockFile } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-io-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readCatalog
// ---------------------------------------------------------------------------

describe("readCatalog", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("reads a valid cat.yaml and returns typed catalog", () => {
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "my-skill": {
          source: "npm:@scope/my-skill",
          rating: 5,
          type: "skill",
        },
      },
    };
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, yaml.dump(catalog), "utf-8");

    const result = readCatalog(tmpDir);
    expect(result.meta.pi_version).toBe("1.0.0");
    expect(result.packages["my-skill"].source).toBe("npm:@scope/my-skill");
    expect(result.packages["my-skill"].rating).toBe(5);
    expect(result.packages["my-skill"].type).toBe("skill");
  });

  it("returns empty catalog when cat.yaml is missing", () => {
    const result = readCatalog(tmpDir);
    expect(result).toEqual({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
  });

  it("returns empty catalog when cat.yaml is empty file", () => {
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf-8");

    const result = readCatalog(tmpDir);
    expect(result).toEqual({
      meta: { pi_version: "0.0.0" },
      packages: {},
    });
  });

  it("throws on malformed YAML content", () => {
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "meta:\n  pi_version: 1.0.0\n  [invalid yaml", "utf-8");

    expect(() => readCatalog(tmpDir)).toThrow();
  });

  it("throws on valid YAML that does not match schema", () => {
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, yaml.dump({ meta: { pi_version: "1.0.0" } }), "utf-8");

    expect(() => readCatalog(tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeCatalog
// ---------------------------------------------------------------------------

describe("writeCatalog", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("writes a valid cat.yaml that can be round-tripped", () => {
    const catalog: CatalogYaml = {
      meta: { pi_version: "2.0.0" },
      packages: {
        "skill-a": {
          source: "git:https://github.com/example/skill-a#subpath",
          rating: 4,
          type: "skill",
          profile: "work",
        },
        "skill-b": {
          source: "npm:skill-b",
          rating: 3,
        },
      },
    };

    writeCatalog(catalog, tmpDir);

    // Read the raw file and verify it's valid YAML
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw);
    const roundTripped = CatalogYamlSchema.parse(parsed);

    expect(roundTripped).toEqual(catalog);
  });

  it("creates directory if it does not exist", () => {
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {},
    };

    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "cat.yaml");
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);

    writeCatalog(catalog, tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("overwrites existing cat.yaml", () => {
    const v1: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "old-skill": { source: "npm:old", rating: 1 },
      },
    };
    const v2: CatalogYaml = {
      meta: { pi_version: "2.0.0" },
      packages: {
        "new-skill": { source: "npm:new", rating: 5 },
      },
    };

    writeCatalog(v1, tmpDir);
    writeCatalog(v2, tmpDir);

    const result = readCatalog(tmpDir);
    expect(result.meta.pi_version).toBe("2.0.0");
    expect(result.packages["new-skill"]).toBeDefined();
    expect(result.packages["old-skill"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readLock
// ---------------------------------------------------------------------------

describe("readLock", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("reads a valid catalog.lock.json and returns typed lock", () => {
    const lock: LockFile = {
      packages: {
        "my-skill": {
          version: "1.2.3",
          contentHash: "sha256-abc123",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "synced",
        },
      },
    };

    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "catalog.lock.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(lock, null, 2), "utf-8");

    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  it("returns empty lock when catalog.lock.json is missing", () => {
    const result = readLock(tmpDir);
    expect(result).toEqual({ packages: {} });
  });

  it("throws on malformed JSON", () => {
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "catalog.lock.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{invalid json", "utf-8");

    expect(() => readLock(tmpDir)).toThrow();
  });

  it("throws on valid JSON that does not match schema", () => {
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "catalog.lock.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ packages: { bad: { version: 123 } } }), "utf-8");

    expect(() => readLock(tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeLock
// ---------------------------------------------------------------------------

describe("writeLock", () => {
  beforeEach(() => makeHome());
  afterEach(() => cleanup());

  it("writes a valid catalog.lock.json that can be round-tripped", () => {
    const lock: LockFile = {
      packages: {
        "skill-a": {
          version: "0.1.0",
          contentHash: "sha256-aaa",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "synced",
        },
        "skill-b": {
          version: "2.0.0",
          contentHash: "sha256-bbb",
          installedAt: "2026-05-28T08:30:00Z",
          syncState: "outdated",
        },
      },
    };

    writeLock(lock, tmpDir);

    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "catalog.lock.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const roundTripped = LockFileSchema.parse(parsed);
    expect(roundTripped).toEqual(lock);
  });

  it("creates directory if it does not exist", () => {
    const lock: LockFile = { packages: {} };
    const filePath = path.join(tmpDir, ".pi", "sf", "catalog", "catalog.lock.json");
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);

    writeLock(lock, tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("overwrites existing lock file", () => {
    const v1: LockFile = {
      packages: {
        "old": {
          version: "1.0.0",
          contentHash: "sha256-old",
          installedAt: "2026-01-01T00:00:00Z",
          syncState: "synced",
        },
      },
    };
    const v2: LockFile = {
      packages: {
        "new": {
          version: "2.0.0",
          contentHash: "sha256-new",
          installedAt: "2026-06-01T00:00:00Z",
          syncState: "outdated",
        },
      },
    };

    writeLock(v1, tmpDir);
    writeLock(v2, tmpDir);

    const result = readLock(tmpDir);
    expect(result.packages["new"]).toBeDefined();
    expect(result.packages["old"]).toBeUndefined();
  });
});
