import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * Ensures a bearer token exists at the given path. Race-safe via O_EXCL:
 * the first caller creates the file; concurrent callers catch EEXIST and read.
 */
export async function ensureToken(tokenPath: string): Promise<string> {
  const dir = dirname(tokenPath);
  mkdirSync(dir, { recursive: true });
  
  const token = randomUUID();
  try {
    // Atomic create-exclusive: O_CREAT | O_EXCL fails with EEXIST if file exists
    const fd = openSync(tokenPath, "wx", 0o600);
    try {
      writeFileSync(fd, token, "utf8");
    } finally {
      closeSync(fd);
    }
    // Ensure permissions are restrictive (in case umask modified them)
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
    return token;
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "EEXIST") {
      // Another caller won the race; read their token
      return readFileSync(tokenPath, "utf8").trim();
    }
    throw e;
  }
}
