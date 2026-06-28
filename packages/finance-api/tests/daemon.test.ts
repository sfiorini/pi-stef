import { describe, it, expect, vi } from "vitest";
import { startDaemon, getNextTickDelay } from "../src/scheduler/daemon";

// Export getNextTickDelay for testing
export { getNextTickDelay };

describe("daemon", () => {
  it("getNextTickDelay returns correct delays per session", () => {
    expect(getNextTickDelay("pre")).toBe(30 * 60 * 1000); // 30 min
    expect(getNextTickDelay("intraday")).toBe(30 * 60 * 1000); // 30 min
    expect(getNextTickDelay("post")).toBe(60 * 60 * 1000); // 1 hour
    expect(getNextTickDelay("closed")).toBe(4 * 60 * 60 * 1000); // 4 hours
  });

  it("startDaemon returns handle with stop function", () => {
    const handle = startDaemon({
      db: {} as never,
      registry: new Map(),
      creds: {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(handle).toHaveProperty("stop");
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });
});
