/**
 * Profile manager for multi-profile catalog support.
 *
 * Profiles allow different package sets for different machines or contexts
 * (e.g., work vs personal). Each profile has its own package overrides that
 * merge over the base packages.
 */

import type { CatalogYaml, CatalogPackage } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the default profile (always available). */
export const DEFAULT_PROFILE = "default";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure the catalog has a profiles record, creating one if needed. */
function ensureProfiles(catalog: CatalogYaml): CatalogYaml {
  if (catalog.profiles === undefined) {
    return { ...catalog, profiles: {} };
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

/**
 * Create a new empty profile.
 *
 * @throws if a profile with the given name already exists
 */
export function createProfile(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  if (name === DEFAULT_PROFILE) {
    throw new Error(`The "${DEFAULT_PROFILE}" profile always exists`);
  }

  const withProfiles = ensureProfiles(catalog);

  if (withProfiles.profiles![name]) {
    throw new Error(`Profile "${name}" already exists`);
  }

  return {
    ...withProfiles,
    profiles: {
      ...withProfiles.profiles!,
      [name]: { packages: {} },
    },
  };
}

// ---------------------------------------------------------------------------
// switchProfile
// ---------------------------------------------------------------------------

/**
 * Switch the active profile.
 *
 * @throws if the target profile does not exist
 */
export function switchProfile(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  if (name !== DEFAULT_PROFILE) {
    if (!catalog.profiles?.[name]) {
      throw new Error(`Profile "${name}" not found`);
    }
  }

  return {
    ...catalog,
    meta: {
      ...catalog.meta,
      activeProfile: name,
    },
  };
}

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

/**
 * Delete a profile.
 *
 * @throws if the profile does not exist
 * @throws if attempting to delete the default profile
 */
export function deleteProfile(
  catalog: CatalogYaml,
  name: string,
): CatalogYaml {
  if (name === DEFAULT_PROFILE) {
    throw new Error(`Cannot delete the "${DEFAULT_PROFILE}" profile`);
  }

  if (!catalog.profiles?.[name]) {
    throw new Error(`Profile "${name}" not found`);
  }

  const { [name]: _, ...remainingProfiles } = catalog.profiles;

  // Clear activeProfile if it was the deleted profile
  const meta = { ...catalog.meta };
  if (meta.activeProfile === name) {
    delete meta.activeProfile;
  }

  return {
    ...catalog,
    meta,
    profiles: remainingProfiles,
  };
}

// ---------------------------------------------------------------------------
// resolveEffectivePackages
// ---------------------------------------------------------------------------

/**
 * Resolve the effective package set by merging base packages with
 * the active (or specified) profile's overrides.
 *
 * Profile packages override base packages with the same key.
 * If no profile is specified, uses `meta.activeProfile` (falling back
 * to `DEFAULT_PROFILE`).
 */
export function resolveEffectivePackages(
  catalog: CatalogYaml,
  profile?: string,
): Record<string, CatalogPackage> {
  const profileName = profile ?? catalog.meta.activeProfile ?? DEFAULT_PROFILE;

  // Start with a shallow clone of base packages
  const result: Record<string, CatalogPackage> = { ...catalog.packages };

  // Merge profile overrides on top
  if (profileName !== DEFAULT_PROFILE) {
    const profilePkgs = catalog.profiles?.[profileName]?.packages;
    if (profilePkgs) {
      for (const [key, value] of Object.entries(profilePkgs)) {
        result[key] = value;
      }
    }
  }

  return result;
}
