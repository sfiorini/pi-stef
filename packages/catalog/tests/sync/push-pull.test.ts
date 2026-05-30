import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Mock child_process so no real processes are spawned
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @octokit/rest
// ---------------------------------------------------------------------------
const gists = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
};

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function () {
    return { gists };
  }),
}));

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
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { _resetOctokit } from "../../src/sync/gist.js";

const mockedExecFile = vi.mocked(execFile);
const mockedFs = vi.mocked(fs);

// ---------------------------------------------------------------------------
// Sequential mock helper
// ---------------------------------------------------------------------------

type ExecResult = { error?: Error | null; stdout?: string; stderr?: string };

/**
 * Queue mock results that will be returned in order for each execFile call.
 */
function mockExecFileQueue(results: ExecResult[]): void {
  const queue = [...results];
  mockedExecFile.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (..._args: any[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const next = queue.shift();
      if (next) {
        cb(next.error ?? null, next.stdout ?? "", next.stderr ?? "");
      } else {
        cb(new Error("unexpected execFile call"), "", "");
      }
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/** Sample catalog object. */
function sampleCatalog() {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-skill": {
        source: "https://example.com/skill.tar.gz",
        rating: "core" as const,
      },
    },
  };
}

/** Sample lock object. */
function sampleLock() {
  return {
    packages: {
      "my-skill": {
        version: "1.2.3",
        contentHash: "sha256-abc123",
        installedAt: "2025-01-01T00:00:00Z",
        syncState: "synced" as const,
      },
    },
  };
}

/** Build gist files map (as returned by readGist) from catalog + lock. */
function gistFilesFrom(catalog: object, lock: object) {
  return {
    "cat.yaml": { content: yaml.dump(catalog) },
    "catalog.lock.json": { content: JSON.stringify(lock, null, 2) },
  };
}

/** JSON for gh gist list output. */
function gistListJson(gists: Array<{ id: string; description?: string }>) {
  return JSON.stringify(gists);
}

/** JSON for gh gist create output. */
function gistCreateJson(id: string, url: string) {
  return JSON.stringify({ id, html_url: url });
}

/** JSON for gh gist update (PATCH) output. */
function gistUpdateJson(id: string, url: string) {
  return JSON.stringify({ id, html_url: url });
}

/** JSON for gh gist view (read) output. */
function gistViewJson(id: string, files: Record<string, { content: string }>) {
  return JSON.stringify({ id, files });
}

// ---------------------------------------------------------------------------
// Import targets after all mocks
// ---------------------------------------------------------------------------
import { pushCatalog } from "../../src/sync/push.js";
import { pullCatalog } from "../../src/sync/pull.js";

// ===========================================================================
// pushCatalog
// ===========================================================================
describe("pushCatalog", () => {
  const profile = "default";
  const description = `catalog-${profile}`;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
    // Default: .gist file does not exist
    mockedFs.existsSync.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  it("creates a new gist when none exists and returns its URL", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    // Queue: findGistByDescription → empty list, createGist → success
    mockExecFileQueue([
      { stdout: gistListJson([]) },                          // findGistByDescription
      { stdout: gistCreateJson("new-gist-1", "https://gist.github.com/new-gist-1") }, // createGist
    ]);

    const result = await pushCatalog(catalog, lock, profile);

    expect(result.gistId).toBe("new-gist-1");
    expect(result.gistUrl).toBe("https://gist.github.com/new-gist-1");
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  it("updates an existing gist when one matches the description", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    // Queue: findGistByDescription → found, updateGist → success
    mockExecFileQueue([
      { stdout: gistListJson([{ id: "existing-1", description }]) }, // findGistByDescription
      { stdout: gistUpdateJson("existing-1", "https://gist.github.com/existing-1") }, // updateGist
    ]);

    const result = await pushCatalog(catalog, lock, profile);

    expect(result.gistId).toBe("existing-1");
    expect(result.gistUrl).toBe("https://gist.github.com/existing-1");

    // Verify the second call was PATCH (update), not POST (create)
    const secondCallArgs = mockedExecFile.mock.calls[1][1] as string[];
    expect(secondCallArgs).toContain("PATCH");
  });

  // -------------------------------------------------------------------------
  it("uses cached gist ID from .gist file when available", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    // .gist file exists with cached ID
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("cached-gist-id-42");

    // Only updateGist is called (single execFile call)
    mockExecFileQueue([
      { stdout: gistUpdateJson("cached-gist-id-42", "https://gist.github.com/cached-gist-id-42") },
    ]);

    const result = await pushCatalog(catalog, lock, profile);

    expect(result.gistId).toBe("cached-gist-id-42");

    // Should NOT call findGistByDescription — only one execFile call
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const callArgs = mockedExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain("PATCH");
  });

  // -------------------------------------------------------------------------
  it("persists gist ID to .gist file after creating a new gist", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    mockExecFileQueue([
      { stdout: gistListJson([]) },
      { stdout: gistCreateJson("brand-new-99", "https://gist.github.com/brand-new-99") },
    ]);

    await pushCatalog(catalog, lock, profile);

    // writeFileSync should be called with the gist ID
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".gist"),
      "brand-new-99",
      "utf-8",
    );
  });

  // -------------------------------------------------------------------------
  it("serializes catalog as YAML and lock as JSON in gist files", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("gist-serialize-test");

    // Capture stdin to verify serialized content
    let capturedStdin = "";
    mockedExecFile.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (..._args: any[]) => {
        // The actual implementation writes stdin via child.stdin
        // For this test we just verify the result comes back correctly
        const cb = _args[_args.length - 1] as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        cb(null, gistUpdateJson("gist-serialize-test", "https://gist.github.com/gist-serialize-test"), "");
        return {
          stdin: {
            write: (data: string) => { capturedStdin = data; },
            end: () => {},
          },
        } as unknown as ReturnType<typeof execFile>;
      },
    );

    const result = await pushCatalog(catalog, lock, profile);

    expect(result.gistId).toBe("gist-serialize-test");
    // Verify stdin contains the serialized catalog and lock
    expect(capturedStdin).toContain("cat.yaml");
    expect(capturedStdin).toContain("catalog.lock.json");
    expect(capturedStdin).toContain("pi_version");
    expect(capturedStdin).toContain("contentHash");
  });
});

// ===========================================================================
// pullCatalog
// ===========================================================================
describe("pullCatalog", () => {
  const profile = "default";
  const description = `catalog-${profile}`;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
    mockedFs.existsSync.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  it("fetches and deserializes catalog and lock from gist by cached ID", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("cached-gist-for-pull");

    // Only readGist is called (single execFile call)
    mockExecFileQueue([
      { stdout: gistViewJson("cached-gist-for-pull", gistFilesFrom(catalog, lock)) },
    ]);

    const result = await pullCatalog(profile);

    expect(result.catalog).toEqual(catalog);
    expect(result.lock).toEqual(lock);
  });

  // -------------------------------------------------------------------------
  it("finds gist by description when no cached ID exists", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    mockedFs.existsSync.mockReturnValue(false);

    // Queue: findGistByDescription → found, readGist → gist data
    mockExecFileQueue([
      { stdout: gistListJson([{ id: "found-by-desc", description }]) },
      { stdout: gistViewJson("found-by-desc", gistFilesFrom(catalog, lock)) },
    ]);

    const result = await pullCatalog(profile);

    expect(result.catalog).toEqual(catalog);
    expect(result.lock).toEqual(lock);
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  it("throws when no gist is found for the profile", async () => {
    mockedFs.existsSync.mockReturnValue(false);

    // findGistByDescription returns empty list
    mockExecFileQueue([
      { stdout: gistListJson([]) },
    ]);

    await expect(pullCatalog(profile)).rejects.toThrow(
      /no gist found/i,
    );
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  it("caches discovered gist ID to .gist file when no cached ID existed", async () => {
    const catalog = sampleCatalog();
    const lock = sampleLock();

    mockedFs.existsSync.mockReturnValue(false);

    // Queue: findGistByDescription → found, readGist → gist data
    mockExecFileQueue([
      { stdout: gistListJson([{ id: "discovered-gist-7", description }]) },
      { stdout: gistViewJson("discovered-gist-7", gistFilesFrom(catalog, lock)) },
    ]);

    const result = await pullCatalog(profile);

    expect(result.catalog).toEqual(catalog);
    // The discovered gist ID should be persisted to the cache
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".gist"),
      "discovered-gist-7",
      "utf-8",
    );
  });

  // -------------------------------------------------------------------------
  it("deserializes YAML catalog correctly (preserves types)", async () => {
    const catalog = {
      meta: { pi_version: "2.0.0" },
      packages: {
        "skill-a": {
          source: "https://example.com/a",
          rating: "useful" as const,
          enabled: false,
          previousRating: "core" as const,
        },
      },
    };
    const lock = { packages: {} };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("gist-type-check");

    mockExecFileQueue([
      { stdout: gistViewJson("gist-type-check", gistFilesFrom(catalog, lock)) },
    ]);

    const result = await pullCatalog(profile);

    expect(result.catalog.meta.pi_version).toBe("2.0.0");
    expect(result.catalog.packages["skill-a"].rating).toBe("useful");
    expect(result.catalog.packages["skill-a"].enabled).toBe(false);
    expect(result.catalog.packages["skill-a"].previousRating).toBe("core");
  });

  // -------------------------------------------------------------------------
  it("deserializes lock JSON correctly (preserves types)", async () => {
    const catalog = { meta: { pi_version: "1.0.0" }, packages: {} };
    const lock = {
      packages: {
        "pkg-x": {
          version: "3.1.4",
          contentHash: "sha256-deadbeef",
          installedAt: "2025-06-15T12:00:00Z",
          syncState: "outdated" as const,
        },
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("gist-lock-check");

    mockExecFileQueue([
      { stdout: gistViewJson("gist-lock-check", gistFilesFrom(catalog, lock)) },
    ]);

    const result = await pullCatalog(profile);

    expect(result.lock.packages["pkg-x"].version).toBe("3.1.4");
    expect(result.lock.packages["pkg-x"].syncState).toBe("outdated");
  });
});
