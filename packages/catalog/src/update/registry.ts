/**
 * Fetches the latest version of an npm package by running `npm view <pkg> version`.
 *
 * Returns the version string (trimmed), or undefined on any error.
 */
import { execFile } from "node:child_process";

export async function fetchLatestVersion(
  packageName: string,
  timeout = 10_000,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      "npm",
      ["view", packageName, "version"],
      { timeout },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const version = typeof stdout === "string" ? stdout.trim() : "";
        resolve(version.length > 0 ? version : undefined);
      },
    );
  });
}
