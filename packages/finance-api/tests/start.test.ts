import { describe, it, expect } from "vitest";
import { startServer } from "../src/server/start";
import { openDb } from "../src/store/db";
import { ensureToken } from "../src/server/bootstrap";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("startServer", () => {
  it("starts and stops on a random port", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "server-"));
    const tokenPath = join(tmp, "token");
    const token = await ensureToken(tokenPath);
    const db = openDb(":memory:");
    
    const handle = await startServer({ db, token, port: 0 }); // port 0 = random
    expect(handle.port).toBeGreaterThan(0);
    handle.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects with clear error on EADDRINUSE", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "server-"));
    const tokenPath = join(tmp, "token");
    const token = await ensureToken(tokenPath);
    const db = openDb(":memory:");
    
    // Start first server
    const handle1 = await startServer({ db, token, port: 0 });
    
    // Try to start second server on same port
    await expect(startServer({ db, token, port: handle1.port }))
      .rejects.toThrow(/already in use|EADDRINUSE/i);
    
    handle1.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
