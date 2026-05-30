/**
 * Shared types for all catalog subcommand handlers.
 *
 * Every command receives a `CommandArgs` (parsed by the dispatcher) and a
 * `CommandCtx` (provided by the pi extension runtime).  Individual commands
 * may extend these base types with extra UI methods (e.g. `select`, `confirm`).
 */

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Arguments parsed from the command line by the dispatcher. */
export interface CommandArgs {
  /** Positional (non-flag) arguments, in order of appearance. */
  positional: string[];
  /** Parsed flags. Boolean flags are `true`; key=value flags hold the string
   *  value. */
  flags: Record<string, true | string>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Base context provided by the pi extension runtime.
 *
 * Individual commands extend this with additional UI capabilities
 * (e.g. `select`, `confirm`) as needed.
 */
export interface CommandCtx {
  ui: {
    notify: (msg: string, type?: "error" | "info" | "warning") => void;
  };
  /** Home directory override (for testing). */
  home?: string;
}
