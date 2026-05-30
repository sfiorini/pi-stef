/**
 * `ct login` subcommand implementation.
 *
 * Authenticates the user via the GitHub CLI (`gh`) and auto-pulls their
 * remote catalog on success.
 *
 * Flow:
 *   1. Check if `gh` is installed and the user is authenticated.
 *   2. If already authenticated: notify success and auto-pull the remote catalog.
 *   3. If not authenticated: provide instructions to run `gh auth login`.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { checkAuth } from "../sync/auth.js";
import { pullCatalog } from "../sync/pull.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `loginCommand`. Uses the base `CommandCtx`. */
export type LoginCtx = CommandCtx;

// ---------------------------------------------------------------------------
// loginCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct login` subcommand.
 *
 * Checks authentication status via `checkAuth()`. If authenticated,
 * auto-pulls the remote catalog. If not, provides guidance.
 */
export async function loginCommand(
  args: CommandArgs,
  ctx: LoginCtx,
): Promise<void> {
  const { flags } = args;
  const profile =
    typeof flags["profile"] === "string" ? flags["profile"] : "default";

  // --- 1. Check authentication status ----------------------------------------
  const isAuthenticated = await checkAuth();

  if (!isAuthenticated) {
    ctx.ui.notify(
      "Not authenticated with GitHub. Run the following to log in:\n" +
        "  gh auth login\n" +
        "Then re-run `ct login` to connect your catalog.",
      "info",
    );
    return;
  }

  // --- 2. Already authenticated — auto-pull ---------------------------------
  ctx.ui.notify("Already authenticated with GitHub.", "info");

  try {
    await pullCatalog(profile, ctx.home);
    ctx.ui.notify(
      `Login successful. Pulled remote catalog for profile "${profile}".`,
      "info",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // If no gist exists, provide first-time guidance
    if (message.includes("No gist found")) {
      ctx.ui.notify(
        "Login successful, but no remote catalog found. " +
          "Use `ct add` to add packages, then `ct sync` to create and push your catalog.",
        "info",
      );
      return;
    }

    ctx.ui.notify(
      `Login successful, but pull failed: ${message}`,
      "warning",
    );
  }
}
