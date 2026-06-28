import { describe, it, expect } from "vitest";
import { createLogger } from "../src/server/logger";
import { loadSecrets, saveSecrets } from "../src/ingest/secrets";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("logger + secrets", () => {
  it("logger redacts sensitive keys", () => {
    const logger = createLogger();
    // Capture stderr
    const originalWrite = process.stderr.write;
    let output = "";
    process.stderr.write = (chunk: string) => { output += chunk; return true; };
    
    logger.info("test", { token: "secret123", name: "test" });
    
    process.stderr.write = originalWrite;
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret123");
  });

  it("saveSecrets creates file with 0600 permissions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "secrets-"));
    const secretsPath = join(tmp, "secrets.json");
    saveSecrets(secretsPath, { coinbase: { keyName: "k", privateKey: "s" } });
    const stats = statSync(secretsPath);
    // Check permissions (0600 = owner read/write only)
    expect(stats.mode & 0o777).toBe(0o600);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadSecrets returns empty object when file doesn't exist", () => {
    const creds = loadSecrets("/tmp/does-not-exist-secrets.json");
    expect(creds).toEqual({});
  });
});
