/**
 * Command dispatcher and argument parsing for the `/ct` extension commands.
 *
 * `parseSubcommand` splits a raw argument list (e.g. `["sync", "--force"]`)
 * into a structured `{ subcommand, flags, positional }` object.
 *
 * Subcommand names and aliases are derived from the shared definitions in
 * `definitions.ts` — the single source of truth.
 */

import {
  getSubcommandNames,
  resolveCanonical,
} from "./definitions.js";

// ---------------------------------------------------------------------------
// Re-export derived constants for backward compatibility
// ---------------------------------------------------------------------------

/** Canonical subcommand names accepted by the `/ct` command. */
export const SUBCOMMANDS = getSubcommandNames() as readonly string[];

/** Canonical subcommand name type derived from the definitions. */
export type SubcommandName = (typeof SUBCOMMANDS)[number];

// ---------------------------------------------------------------------------
// resolveAlias (delegates to shared definitions)
// ---------------------------------------------------------------------------

/**
 * Map a token to its canonical subcommand name.
 *
 * Delegates to `resolveCanonical` from the shared definitions module.
 */
export function resolveAlias(token: string): SubcommandName | undefined {
  return resolveCanonical(token) as SubcommandName | undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  /** Canonical subcommand name, or `undefined` when the first token is not
   *  a recognized subcommand or alias. */
  subcommand: SubcommandName | undefined;
  /** Parsed flags. Boolean flags are `true`; key=value flags hold the string
   *  value (no type coercion beyond that). */
  flags: Record<string, true | string>;
  /** Positional (non-flag) arguments, in order of appearance. */
  positional: string[];
}

// ---------------------------------------------------------------------------
// parseSubcommand
// ---------------------------------------------------------------------------

/**
 * Parse the raw argument string array that accompanies a `/ct` invocation.
 *
 * The first token is treated as the subcommand (subject to alias resolution).
 * Tokens starting with `--` are flags:
 *   - `--flag`        →  `{ flag: true }`
 *   - `--key=value`   →  `{ key: "value" }`
 * All other tokens are collected as positional arguments.
 */
export function parseSubcommand(args: string[]): ParsedCommand {
  const flags: Record<string, true | string> = {};
  const positional: string[] = [];

  let subcommand: SubcommandName | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    // First non-flag token is the subcommand.
    if (subcommand === undefined && !token.startsWith("--")) {
      subcommand = resolveAlias(token);
      continue;
    }

    // Flag tokens.
    if (token.startsWith("--")) {
      const body = token.slice(2);

      if (body.includes("=")) {
        const eqIdx = body.indexOf("=");
        const key = body.slice(0, eqIdx);
        const value = body.slice(eqIdx + 1);
        flags[key] = value;
      } else {
        flags[body] = true;
      }
      continue;
    }

    // Everything else is positional.
    positional.push(token);
  }

  return { subcommand, flags, positional };
}
