import { describe, it, expect } from "vitest";
import { ensureToken } from "../src/server/bootstrap";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ensureToken", () => {
  it("creates a token on first run and reuses it after", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "fin-tok-"));
    const tokenPath = join(tmp, "token");
    const t1 = await ensureToken(tokenPath);
    const t2 = await ensureToken(tokenPath);
    expect(t1).toBeTruthy();
    expect(t1).toBe(t2);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is safe under concurrent first-run (create-exclusive, no corruption)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "fin-tok-race-"));
    const tokenPath = join(tmp, "token");
    const tokens = await Promise.all([ensureToken(tokenPath), ensureToken(tokenPath), ensureToken(tokenPath)]);
    // all callers see the SAME token (winner writes, losers read the winner's file)
    expect(new Set(tokens).size).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});
