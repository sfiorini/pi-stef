import { readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import type { IngestCreds } from "./registry";
import type { Logger } from "../server/logger";

/**
 * Loads secrets from the secrets file. Returns empty object if file doesn't exist.
 * When creating the file, sets permissions to 0600 for security.
 */
export function loadSecrets(secretsPath: string, log?: Logger): IngestCreds {
  try {
    const raw = readFileSync(secretsPath, "utf8");
    return JSON.parse(raw) as IngestCreds;
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT") {
      return {};
    }
    throw e;
  }
}

/**
 * Saves secrets to the file with 0600 permissions.
 * If file exists with broader permissions, tightens to 0600.
 */
export function saveSecrets(secretsPath: string, creds: IngestCreds, log?: Logger): void {
  writeFileSync(secretsPath, JSON.stringify(creds, null, 2), "utf8");
  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // Best effort; may fail on some systems
  }
}
