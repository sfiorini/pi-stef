import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of running a child-process command.
 * Minimal version used internally by this module.
 */
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a command via `execFile` and resolve with a ShellResult regardless of
 * exit code. Rejects only on truly unexpected errors (e.g. bad arguments).
 */
function runQuiet(
  command: string,
  args: string[],
  timeout = 5_000,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    execFile(
      command,
      args,
      { timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");

        if (error) {
          const exitCode =
            typeof (error as Error & { status?: number }).status === "number"
              ? (error as Error & { status?: number }).status!
              : 1;
          resolve({ stdout: out, stderr: err, exitCode });
        } else {
          resolve({ stdout: out, stderr: err, exitCode: 0 });
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the GitHub CLI (`gh`) is installed on the system.
 *
 * Returns `true` when `gh --version` exits with code 0, `false` otherwise.
 */
export async function isGhInstalled(): Promise<boolean> {
  try {
    const result = await runQuiet("gh", ["--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether the GitHub CLI (`gh`) is installed and the user is
 * authenticated.
 *
 * Returns `true` when `gh auth status` exits with code 0, `false` otherwise
 * (including when `gh` is not installed at all).
 */
export async function checkAuth(): Promise<boolean> {
  const result = await runQuiet("gh", ["auth", "status"]);
  return result.exitCode === 0;
}

/**
 * Obtain a GitHub personal-access token.
 *
 * Strategy:
 *  1. Try `gh auth token` — if it succeeds, return the trimmed token.
 *  2. Fall back to the `GITHUB_TOKEN` environment variable.
 *  3. Return `undefined` when neither source yields a token.
 */
export async function getToken(): Promise<string | undefined> {
  // 1. Try gh CLI
  const result = await runQuiet("gh", ["auth", "token"]);
  if (result.exitCode === 0) {
    const token = result.stdout.trim();
    if (token.length > 0) {
      return token;
    }
  }

  // 2. Fall back to environment variable
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  // 3. Nothing available
  return undefined;
}
