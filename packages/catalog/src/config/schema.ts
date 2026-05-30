import { z } from "zod";

// ---------------------------------------------------------------------------
// cat.yaml schema
// ---------------------------------------------------------------------------

/** Type discriminator for a catalog package entry. */
export const PackageType = z.enum(["skill", "pi-native"]);

/** A single package entry inside cat.yaml. */
export const CatalogPackageSchema = z.object({
  /** Where to fetch the package from (URL, path, etc.). */
  source: z.string().min(1),
  /** User-assigned rating 1–5. */
  rating: z.number().int().min(1).max(5),
  /** Optional type discriminator. */
  type: PackageType.optional(),
  /** Optional profile name this package belongs to. */
  profile: z.string().optional(),
});

/** The meta section at the top of cat.yaml. */
export const CatalogMetaSchema = z.object({
  /** Minimum pi version this catalog requires. */
  pi_version: z.string().min(1),
});

/** Full cat.yaml document schema. */
export const CatalogYamlSchema = z.object({
  meta: CatalogMetaSchema,
  packages: z.record(z.string(), CatalogPackageSchema),
});

// ---------------------------------------------------------------------------
// catalog.lock.json schema
// ---------------------------------------------------------------------------

/** Possible sync states for a locked package. */
export const SyncState = z.enum(["synced", "outdated", "conflict"]);

/** A single package entry inside catalog.lock.json. */
export const LockPackageSchema = z.object({
  /** Installed version string. */
  version: z.string().min(1),
  /** SHA-256 (or similar) hash of the installed content. */
  contentHash: z.string().min(1),
  /** ISO-8601 timestamp of when the package was installed. */
  installedAt: z.string().min(1),
  /** Current synchronization state relative to the source. */
  syncState: SyncState,
});

/** Full catalog.lock.json document schema. */
export const LockFileSchema = z.object({
  packages: z.record(z.string(), LockPackageSchema),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type CatalogYaml = z.infer<typeof CatalogYamlSchema>;
export type CatalogMeta = z.infer<typeof CatalogMetaSchema>;
export type CatalogPackage = z.infer<typeof CatalogPackageSchema>;
export type LockFile = z.infer<typeof LockFileSchema>;
export type LockPackage = z.infer<typeof LockPackageSchema>;
