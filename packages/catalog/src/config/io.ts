import fs from "node:fs";
import yaml from "js-yaml";

import { catalogFile, lockFile, ensureCatalogDir } from "./paths.js";
import { CatalogYamlSchema, LockFileSchema } from "./schema.js";
import type { CatalogYaml, LockFile } from "./schema.js";

// ---------------------------------------------------------------------------
// Empty defaults
// ---------------------------------------------------------------------------

const EMPTY_CATALOG: CatalogYaml = {
  meta: { pi_version: "0.0.0" },
  packages: {},
};

const EMPTY_LOCK: LockFile = { packages: {} };

// ---------------------------------------------------------------------------
// cat.yaml I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse `cat.yaml`. Returns an empty catalog when the file is
 * missing or empty. Throws on malformed YAML or schema-invalid content.
 */
export function readCatalog(home?: string): CatalogYaml {
  const filePath = catalogFile(home);

  if (!fs.existsSync(filePath)) {
    return structuredClone(EMPTY_CATALOG);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  if (raw.trim() === "") {
    return structuredClone(EMPTY_CATALOG);
  }

  const parsed = yaml.load(raw);
  return CatalogYamlSchema.parse(parsed);
}

/**
 * Serialize and write `cat.yaml`, creating the catalog directory if needed.
 */
export function writeCatalog(catalog: CatalogYaml, home?: string): void {
  ensureCatalogDir(home);
  const filePath = catalogFile(home);
  const content = yaml.dump(catalog);
  fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// catalog.lock.json I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse `catalog.lock.json`. Returns an empty lock when the file
 * is missing. Throws on malformed JSON or schema-invalid content.
 */
export function readLock(home?: string): LockFile {
  const filePath = lockFile(home);

  if (!fs.existsSync(filePath)) {
    return structuredClone(EMPTY_LOCK);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return LockFileSchema.parse(parsed);
}

/**
 * Serialize and write `catalog.lock.json`, creating the catalog directory
 * if needed.
 */
export function writeLock(lock: LockFile, home?: string): void {
  ensureCatalogDir(home);
  const filePath = lockFile(home);
  const content = JSON.stringify(lock, null, 2) + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}
