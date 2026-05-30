/**
 * Barrel file for @pi-stef/catalog.
 *
 * Re-exports the public API from internal modules so consumers can import
 * from `@pi-stef/catalog` directly.
 */

// catalog
export { scanInstalled, type InstalledPackage, type InstalledMap } from "./catalog/install.js";
export {
  reconcile,
  executeActions,
  type CatalogEntry,
  type InstallAction,
  type UninstallAction,
  type UpgradeAction,
  type OrphanReport,
  type ReconcilePlan,
  type ReconcileOptions,
  type ActionError,
  type ExecuteResult,
  type ExecuteOptions,
} from "./catalog/reconcile.js";
export {
  extractNpmName,
  extractNpmVersion,
  cleanGitName,
  parseSource,
  sourceToKey,
  extractVersionFromSource,
  type ParsedSource,
} from "./catalog/source.js";

// config
export {
  catalogDir,
  catalogFile,
  lockFile,
  ensureCatalogDir,
  npmNodeModulesDir,
} from "./config/paths.js";
export {
  PackageType,
  CatalogPackageSchema,
  CatalogMetaSchema,
  CatalogYamlSchema,
  SyncState,
  LockPackageSchema,
  LockFileSchema,
  type CatalogYaml,
  type CatalogMeta,
  type CatalogPackage,
  type LockFile,
  type LockPackage,
} from "./config/schema.js";

// sync
export { checkAuth, getToken } from "./sync/auth.js";
export {
  createGist,
  readGist,
  updateGist,
  findGistByDescription,
  _resetOctokit,
  type GistFiles,
  type GistResult,
  type GistSummary,
} from "./sync/gist.js";
export {
  gistCachePath,
  readCachedGistId,
  writeCachedGistId,
} from "./sync/cache.js";
export { pullCatalog, type PullResult } from "./sync/pull.js";
export { pushCatalog, type PushResult } from "./sync/push.js";

// util
export {
  execCommand,
  piInstall,
  piUninstall,
  ExecError,
  type ExecOptions,
  type ExecResult,
  type PiExecOptions,
} from "./util/exec.js";
