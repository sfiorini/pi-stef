import path from "node:path";
import fs from "node:fs";
import { globalDir } from "@pi-stef/paths";

/**
 * ~/.pi/sf/catalog/
 */
export function catalogDir(home?: string): string {
  return globalDir("catalog", home);
}

/**
 * ~/.pi/sf/catalog/cat.yaml
 */
export function catalogFile(home?: string): string {
  return path.join(catalogDir(home), "cat.yaml");
}

/**
 * ~/.pi/sf/catalog/catalog.lock.json
 */
export function lockFile(home?: string): string {
  return path.join(catalogDir(home), "catalog.lock.json");
}

/**
 * Creates the catalog directory if it does not already exist.
 */
export function ensureCatalogDir(home?: string): void {
  const dir = catalogDir(home);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
