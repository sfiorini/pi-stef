/**
 * `ct login` subcommand implementation.
 *
 * Authenticates the user via the GitHub CLI (`gh`) and auto-pulls their
 * remote catalog on success.
 *
 * Flow:
 *   1. Detect whether `gh` CLI is installed.
 *   2. Check if the user is authenticated via `gh auth status`.
 *   3. Verify a valid token is available via `getToken()`.
 *   4. Auto-pull the remote catalog on success.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { checkAuth, getToken, isGhInstalled } from "../sync/auth.js";
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
 * Detects `gh` CLI, checks authentication status, verifies token,
 * and auto-pulls the remote catalog on success.
 */
export async function loginCommand(
  args: CommandArgs,
  ctx: LoginCtx,
): Promise<void> {
  const { flags } = args;
  const profile =
    typeof flags["profile"] === "string" ? flags["profile"] : "default";

  // --- 1. Detect gh CLI -----------------------------------------------------
  const ghInstalled = await isGhInstalled();

  if (!ghInstalled) {
    ctx.ui.notify(
      "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com, then re-run `ct login`.",
      "info",
    );
    return;
  }

  // --- 2. Check authentication status ----------------------------------------
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

  // --- 3. Verify token ------------------------------------------------------
  const token = await getToken();

  if (!token) {
    ctx.ui.notify(
      "Authenticated, but no token available. Run `gh auth login` with the `read:gist` scope, then re-run `ct login`.",
      "warning",
    );
    return;
  }

  // --- 4. Already authenticated — auto-pull ---------------------------------
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
