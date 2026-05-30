import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock fs to avoid touching the real filesystem
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock config/paths so catalogDir returns a predictable value
// ---------------------------------------------------------------------------
vi.mock("../../src/config/paths.js", () => ({
  catalogDir: vi.fn((home?: string) =>
    path.join(home ?? "/mock/home", ".pi/sf/catalog"),
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { gistCachePath, readCachedGistId, writeCachedGistId } from "../../src/sync/cache.js";

const mockedFs = vi.mocked(fs);

// ===========================================================================
// gistCachePath
// ===========================================================================
describe("gistCachePath", () => {
  it("returns a path ending in .gist inside the catalog dir", () => {
    const result = gistCachePath();
    expect(result).toMatch(/\.pi\/sf\/catalog\/\.gist$/);
  });

  it("respects custom home directory", () => {
    const result = gistCachePath("/custom/home");
    expect(result).toBe("/custom/home/.pi/sf/catalog/.gist");
  });
});

// ===========================================================================
// readCachedGistId
// ===========================================================================
describe("readCachedGistId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached ID when .gist file exists and has content", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("my-gist-id-123");

    const result = readCachedGistId();

    expect(result).toBe("my-gist-id-123");
  });

  it("trims whitespace from cached ID", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("  my-gist-id-123  \n");

    const result = readCachedGistId();

    expect(result).toBe("my-gist-id-123");
  });

  it("returns undefined when .gist file does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = readCachedGistId();

    expect(result).toBeUndefined();
  });

  it("returns undefined when .gist file is empty", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("   \n");

    const result = readCachedGistId();

    expect(result).toBeUndefined();
  });

  it("returns undefined on read errors (e.g. permission denied)", () => {
    mockedFs.existsSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const result = readCachedGistId();

    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// writeCachedGistId
// ===========================================================================
describe("writeCachedGistId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the gist ID to the .gist file", () => {
    mockedFs.existsSync.mockReturnValue(true);

    writeCachedGistId("new-gist-42");

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".gist"),
      "new-gist-42",
      "utf-8",
    );
  });

  it("creates the parent directory if it does not exist", () => {
    // Directory does not exist
    mockedFs.existsSync.mockReturnValue(false);

    writeCachedGistId("new-gist-42");

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".gist"),
      "new-gist-42",
      "utf-8",
    );
  });

  it("does not create directory when it already exists", () => {
    mockedFs.existsSync.mockReturnValue(true);

    writeCachedGistId("new-gist-42");

    expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });
});
