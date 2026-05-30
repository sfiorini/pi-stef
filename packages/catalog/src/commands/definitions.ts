/**
 * Single source of truth for catalog subcommand definitions.
 *
 * Both `dispatch.ts` (parse-time resolution) and `register.ts` (registration)
 * import from this module, eliminating duplicate subcommand/alias definitions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubcommandDef {
  name: string;
  aliases?: string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Canonical subcommand definitions
// ---------------------------------------------------------------------------

/**
 * Ordered list of all catalog subcommands with their aliases and descriptions.
 *
 * Adding a new subcommand requires updating ONLY this array; `dispatch.ts`
 * and `register.ts` derive everything they need from it.
 */
export const SUBCOMMAND_DEFS: readonly SubcommandDef[] = [
  { name: "sync", description: "Sync catalog with remote gist" },
  { name: "init", description: "Initialize a new catalog" },
  { name: "add", aliases: ["a"], description: "Add a package to the catalog" },
  { name: "remove", aliases: ["rm"], description: "Remove a package from the catalog" },
  { name: "toggle", description: "Toggle a package's rating" },
  { name: "disable", description: "Disable a package" },
  { name: "enable", description: "Enable a package" },
  { name: "push", description: "Push catalog to remote gist" },
  { name: "pull", description: "Pull catalog from remote gist" },
  { name: "login", description: "Authenticate with GitHub for sync" },
  { name: "status", description: "Show catalog status" },
  { name: "diff", description: "Show diff between local and remote catalog" },
  { name: "verify", description: "Verify catalog integrity" },
  { name: "profiles", description: "List available profiles" },
  { name: "profile", description: "Show or switch active profile" },
] as const;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Ordered list of canonical subcommand names. */
export function getSubcommandNames(): readonly string[] {
  return SUBCOMMAND_DEFS.map((d) => d.name);
}

/** Resolve a token to its canonical subcommand name, or `undefined`. */
export function resolveCanonical(token: string): string | undefined {
  for (const def of SUBCOMMAND_DEFS) {
    if (def.name === token) return def.name;
    if (def.aliases?.includes(token)) return def.name;
  }
  return undefined;
}

/**
 * Build a lookup `Map` from subcommand name or alias → canonical name.
 *
 * Useful for registration-time alias mapping.
 */
export function getAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const def of SUBCOMMAND_DEFS) {
    map.set(def.name, def.name);
    for (const alias of def.aliases ?? []) {
      map.set(alias, def.name);
    }
  }
  return map;
}
