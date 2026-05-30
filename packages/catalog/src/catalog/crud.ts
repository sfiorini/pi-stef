import type { CatalogYaml, CatalogPackage } from "../config/schema.js";
import type { RatingValue } from "./ratings.js";
import { isValidSource, isDisabled, nextRating } from "./ratings.js";

// ---------------------------------------------------------------------------
// Immutable helpers
// ---------------------------------------------------------------------------

/** Shallow-clone the catalog and deep-clone the packages record. */
function cloneCatalog(catalog: CatalogYaml): CatalogYaml {
  return {
    ...catalog,
    packages: { ...catalog.packages },
  };
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Add a new package to the catalog.
 *
 * @throws if a package with the same name already exists
 * @throws if the source format is invalid
 */
export function addPackage(
  catalog: CatalogYaml,
  name: string,
  source: string,
  rating: RatingValue,
  type?: "skill" | "pi-native",
): CatalogYaml {
  if (catalog.packages[name]) {
    throw new Error(`Package "${name}" already exists`);
  }

  if (!isValidSource(source)) {
    throw new Error(
      `Invalid source "${source}": must start with "npm:" or "git:"`,
    );
  }

  const entry: CatalogPackage = { source, rating };
  if (type !== undefined) {
    entry.type = type;
  }

  const next = cloneCatalog(catalog);
  next.packages[name] = entry;
  return next;
}

/**
 * Remove a package from the catalog.
 *
 * @throws if the package is not found
 */
export function removePackage(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  if (!catalog.packages[name]) {
    throw new Error(`Package "${name}" not found`);
  }

  const next = cloneCatalog(catalog);
  delete next.packages[name];
  return next;
}

/**
 * Toggle a package's rating through the cycle:
 * core → useful → debatable → disabled → core
 *
 * @throws if the package is not found
 */
export function togglePackage(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  const entry = catalog.packages[name];
  if (!entry) {
    throw new Error(`Package "${name}" not found`);
  }

  const next = cloneCatalog(catalog);
  next.packages[name] = {
    ...entry,
    rating: nextRating(entry.rating),
  };
  return next;
}

/**
 * Enable a disabled package, restoring its previous rating (or "core").
 * No-op when the package is already enabled.
 *
 * @throws if the package is not found
 */
export function enablePackage(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  const entry = catalog.packages[name];
  if (!entry) {
    throw new Error(`Package "${name}" not found`);
  }

  // No-op if already enabled
  if (!isDisabled(entry.rating)) {
    return catalog;
  }

  const restored = entry.previousRating ?? "core";
  const next = cloneCatalog(catalog);
  const { previousRating: _, ...clean } = entry;
  next.packages[name] = { ...clean, rating: restored };
  return next;
}

/**
 * Disable a package, saving its current rating for later restoration.
 *
 * @throws if the package is not found
 */
export function disablePackage(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  const entry = catalog.packages[name];
  if (!entry) {
    throw new Error(`Package "${name}" not found`);
  }

  const next = cloneCatalog(catalog);
  next.packages[name] = {
    ...entry,
    previousRating: entry.rating,
    rating: "disabled",
  };
  return next;
}
