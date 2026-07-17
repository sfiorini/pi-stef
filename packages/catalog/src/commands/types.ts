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
    /** Show a temporary working message (e.g. "Adding..."). Pass undefined or no arg to clear. */
    setWorkingMessage?: (msg?: string) => void;
  };
  /** Home directory override (for testing). */
  home?: string;
  /**
   * Re-discover extensions and rebuild the ExtensionRunner.
   *
   * When present, commands that install/uninstall packages should call this
   * after the operation succeeds so the runtime picks up the change without
   * requiring a manual restart. When absent (e.g. LLM tool context), the
   * command falls back to a "restart required" message.
   */
  reload?: () => Promise<void>;
  /** True when `reload` only queues a follow-up `/reload` (the LLM tool path —
   *  see `withToolReload`) rather than reloading synchronously (slash-command
   *  path). Commands use `reloadNotice()` to phrase the post-reload message. */
  reloadQueued?: boolean;
}

/**
 * Post-reload user message. When `reload` only queued a follow-up `/reload`
 * (the tool path), say so honestly instead of claiming the reload completed —
 * the actual reload runs after the current turn.
 */
export function reloadNotice(ctx: CommandCtx, doneMessage: string): string {
  return ctx.reloadQueued
    ? "Reload queued — new tools available after this turn."
    : doneMessage;
}
