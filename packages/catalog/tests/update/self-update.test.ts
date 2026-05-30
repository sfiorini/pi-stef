import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock node:child_process so no real processes are spawned
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock config/paths
vi.mock("../../src/config/paths.js", () => ({
  catalogDir: vi.fn(() => "/mock/home/.pi/sf/catalog"),
}));

// Mock config/io for lock read/write
vi.mock("../../src/config/io.js", () => ({
  readLock: vi.fn(() => ({ packages: {} })),
  writeLock: vi.fn(),
}));

import { execFile } from "node:child_process";
import { checkSelfUpdate } from "../../src/update/self-update.js";
import { readLock, writeLock } from "../../src/config/io.js";

const mockedExecFile = vi.mocked(execFile);
const mockedReadLock = vi.mocked(readLock);
const mockedWriteLock = vi.mocked(writeLock);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNpmView(version: string): void {
  mockedExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, `${version}\n`, "");
    },
  );
}

function mockNpmViewError(message: string): void {
  mockedExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = new Error(message);
      (err as Error & { code?: string }).code = "ENETUNREACH";
      cb(err, "", message);
    },
  );
}

// ===========================================================================
// checkSelfUpdate
// ===========================================================================
describe("checkSelfUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadLock.mockReturnValue({ packages: {} });
  });

  it("returns updateAvailable=true when a newer version exists", async () => {
    mockNpmView("99.9.9");

    const result = await checkSelfUpdate("0.1.0");

    expect(result.current).toBe("0.1.0");
    expect(result.latest).toBe("99.9.9");
    expect(result.updateAvailable).toBe(true);
  });

  it("returns updateAvailable=false when versions match", async () => {
    mockNpmView("0.1.0");

    const result = await checkSelfUpdate("0.1.0");

    expect(result.current).toBe("0.1.0");
    expect(result.latest).toBe("0.1.0");
    expect(result.updateAvailable).toBe(false);
  });

  it("returns updateAvailable=false when current is newer", async () => {
    mockNpmView("0.0.9");

    const result = await checkSelfUpdate("0.1.0");

    expect(result.updateAvailable).toBe(false);
  });

  it("handles network errors gracefully (returns skip result)", async () => {
    mockNpmViewError("network error");

    const result = await checkSelfUpdate("0.1.0");

    expect(result.current).toBe("0.1.0");
    expect(result.latest).toBeUndefined();
    expect(result.updateAvailable).toBe(false);
  });

  it("calls npm view @pi-stef/catalog version", async () => {
    mockNpmView("1.0.0");

    await checkSelfUpdate("0.1.0");

    expect(mockedExecFile).toHaveBeenCalledWith(
      "npm",
      ["view", "@pi-stef/catalog", "version"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  // --- Rate limiting -------------------------------------------------------

  it("caches the result after a successful check", async () => {
    mockNpmView("2.0.0");

    await checkSelfUpdate("0.1.0");

    // writeLock should have been called with a lock containing update cache
    expect(mockedWriteLock).toHaveBeenCalled();
    const writtenLock = mockedWriteLock.mock.calls[0][0] as Record<string, unknown>;
    expect(writtenLock._updateCache).toBeDefined();
  });

  it("returns cached result when called again within 1 hour", async () => {
    // First call: fresh check
    mockNpmView("2.0.0");
    const oneHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockedReadLock.mockReturnValue({
      packages: {},
      _updateCache: {
        "self-update": {
          latest: "2.0.0",
          checkedAt: oneHourAgo,
        },
      },
    });

    // Second call should use cache, NOT call npm
    const result = await checkSelfUpdate("0.1.0");

    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(result.latest).toBe("2.0.0");
    expect(result.updateAvailable).toBe(true);
  });

  it("performs a fresh check when cache is older than 1 hour", async () => {
    mockNpmView("3.0.0");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockedReadLock.mockReturnValue({
      packages: {},
      _updateCache: {
        "self-update": {
          latest: "1.0.0",
          checkedAt: twoHoursAgo,
        },
      },
    });

    const result = await checkSelfUpdate("0.1.0");

    expect(mockedExecFile).toHaveBeenCalled();
    expect(result.latest).toBe("3.0.0");
  });
});
