import { describe, it, expect } from "vitest";
import { startServer } from "../src/server/start";

describe("startServer", () => {
  it("starts and stops on a random port", async () => {
    const handle = await startServer({ port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    handle.close();
  });

  it("rejects with clear error on EADDRINUSE", async () => {
    // Start first server
    const handle1 = await startServer({ port: 0 });

    // Try to start second server on same port
    await expect(startServer({ port: handle1.port }))
      .rejects.toThrow(/already in use|EADDRINUSE/i);

    handle1.close();
  });
});
