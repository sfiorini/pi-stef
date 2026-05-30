/**
 * User-facing error formatting utilities for the catalog extension.
 *
 * Translates raw system/network errors into actionable messages that
 * guide the user toward a fix (e.g., suggest `ct init --force` for
 * corrupt YAML, or `ct login` for missing gist credentials).
 */

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

/** Returns true when the error looks like a YAML parse failure. */
export function isCorruptYamlError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const lower = msg.toLowerCase();
  return (
    msg.includes("YAMLException") ||
    msg.includes("YAML") && msg.includes("line") ||
    lower.includes("unexpected") && lower.includes("stream") ||
    lower.includes("could not") && lower.includes("yaml") ||
    msg.includes("ZodError") ||
    msg.includes("Expected") && msg.includes("received")
  );
}

/** Returns true when the error indicates a missing gist / no remote. */
export function isMissingGistError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return (
    msg.includes("No gist found") ||
    msg.includes("gist not found") ||
    msg.includes("gist was not found")
  );
}

/** Returns true when the error is network-related. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("econnreset") ||
    msg.includes("timed out") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed")
  );
}

/** Returns true when the error is a filesystem permission error. */
export function isPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return msg.includes("EACCES") || msg.includes("EPERM");
}

// ---------------------------------------------------------------------------
// Auth error detection
// ---------------------------------------------------------------------------

function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return (
    msg.includes("401") ||
    msg.includes("Unauthorized") ||
    msg.includes("403") ||
    msg.includes("Forbidden")
  );
}

// ---------------------------------------------------------------------------
// File not found detection
// ---------------------------------------------------------------------------

function isFileNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return msg.includes("ENOENT");
}

// ---------------------------------------------------------------------------
// formatUserError
// ---------------------------------------------------------------------------

/**
 * Translate a raw error into a user-friendly message with actionable advice.
 *
 * Returns a string suitable for displaying via `ctx.ui.notify(msg, "error")`.
 */
export function formatUserError(err: unknown): string {
  // Handle null/undefined
  if (err == null) {
    return "An unknown error occurred. Please try again or run `ct init` to start fresh.";
  }

  // Handle non-Error values
  if (!(err instanceof Error)) {
    return `Error: ${String(err)}`;
  }

  const msg = err.message ?? "";

  // Corrupt / invalid YAML
  if (isCorruptYamlError(err)) {
    return `${msg}\nYour cat.yaml appears to be corrupt or has an invalid format. Run \`ct init --force\` to regenerate it from your installed packages.`;
  }

  // Auth errors
  if (isAuthError(err)) {
    return `${msg}\nAuthentication failed. Run \`ct login\` to set up your GitHub credentials.`;
  }

  // Missing gist
  if (isMissingGistError(err)) {
    return `${msg}\nNo remote catalog found. Run \`ct login\` to link your GitHub account, then use \`ct sync\` to create a remote gist.`;
  }

  // Permission errors
  if (isPermissionError(err)) {
    return `${msg}\nPermission denied writing to the catalog directory. Check the permissions on \`~/.pi/sf/catalog/\` and try again.`;
  }

  // Network errors
  if (isNetworkError(err)) {
    if (msg.toLowerCase().includes("timed out")) {
      return `${msg}\nNetwork request timed out. Check your internet connection and retry, or use \`--offline\` to work locally.`;
    }
    return `${msg}\nA network error occurred. Check your internet connection and retry, or use \`--offline\` to work locally.`;
  }

  // File not found
  if (isFileNotFoundError(err)) {
    return `${msg}\nA required file was not found. Run \`ct init\` to create a new catalog.`;
  }

  // Generic fallback — always show the message, never a raw stack trace
  return msg;
}
