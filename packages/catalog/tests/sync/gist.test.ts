import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process so no real processes are spawned
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @octokit/rest – we need a proper constructor (not an arrow function).
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

import { execFile } from "node:child_process";
import { Octokit } from "@octokit/rest";

import {
  createGist,
  readGist,
  updateGist,
  findGistByDescription,
  _resetOctokit,
  type GistFiles,
} from "../../src/sync/gist.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedExecFile = vi.mocked(execFile);
const MockedOctokit = vi.mocked(Octokit);

/**
 * Wire execFile mock to call back with the given result.
 */
function mockExecFileResult(result: {
  error?: Error | null;
  stdout?: string;
  stderr?: string;
}): void {
  mockedExecFile.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (..._args: any[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

/** Sample gist files for testing. */
function sampleFiles(): GistFiles {
  return {
    "cat.yaml": "meta:\n  pi_version: 1.0.0\npackages: {}",
    "catalog.lock.json": '{"packages":{}}',
  };
}

// ---------------------------------------------------------------------------
// createGist
// ---------------------------------------------------------------------------

describe("createGist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
  });

  it("uses gh CLI to create a gist when gh is available", async () => {
    // gh api --method POST /gists returns JSON
    mockExecFileResult({
      stdout: JSON.stringify({
        id: "abc123",
        html_url: "https://gist.github.com/abc123",
      }),
      stderr: "",
    });

    const result = await createGist(sampleFiles(), "catalog-default");

    expect(result.id).toBe("abc123");
    expect(result.url).toBe("https://gist.github.com/abc123");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["api", "--method", "POST", "/gists"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes --input flag for JSON body when using gh CLI", async () => {
    mockExecFileResult({
      stdout: JSON.stringify({
        id: "xyz789",
        html_url: "https://gist.github.com/xyz789",
      }),
      stderr: "",
    });

    await createGist(sampleFiles(), "catalog-default");

    // Verify the JSON body passed via stdin contains the description
    const callArgs = mockedExecFile.mock.calls[0] as unknown[];
    // Verify the --input flag is present
    const ghArgs = callArgs[1] as string[];
    expect(ghArgs).toContain("--input");
    expect(ghArgs).toContain("-");
  });

  it("falls back to octokit when gh CLI is not available", async () => {
    // Make gh fail (ENOENT)
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    // Set up octokit mock
    gists.create.mockResolvedValue({
      data: {
        id: "octo-gist-1",
        html_url: "https://gist.github.com/octo-gist-1",
      },
    });

    const result = await createGist(sampleFiles(), "catalog-default");

    expect(result.id).toBe("octo-gist-1");
    expect(MockedOctokit).toHaveBeenCalled();
    expect(gists.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "catalog-default",
        public: false,
      }),
    );
  });

  it("throws when both gh and octokit fail", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.create.mockRejectedValue(new Error("octokit fail"));

    await expect(createGist(sampleFiles(), "catalog-default")).rejects.toThrow(
      /octokit fail/i,
    );
  });
});

// ---------------------------------------------------------------------------
// readGist
// ---------------------------------------------------------------------------

describe("readGist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
  });

  it("uses gh CLI to read a gist when gh is available", async () => {
    const gistData = JSON.stringify({
      id: "abc123",
      files: {
        "cat.yaml": { content: "meta:\n  pi_version: 1.0.0\npackages: {}" },
        "catalog.lock.json": { content: '{"packages":{}}' },
      },
    });
    mockExecFileResult({ stdout: gistData, stderr: "" });

    const result = await readGist("abc123");

    expect(result.files["cat.yaml"].content).toContain("pi_version");
    expect(result.files["catalog.lock.json"].content).toContain("packages");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["gist", "view", "abc123", "--json"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("falls back to octokit when gh CLI is not available", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.get.mockResolvedValue({
      data: {
        id: "octo-1",
        files: {
          "cat.yaml": { content: "yaml-content" },
          "catalog.lock.json": { content: "lock-content" },
        },
      },
    });

    const result = await readGist("octo-1");

    expect(result.files["cat.yaml"].content).toBe("yaml-content");
    expect(gists.get).toHaveBeenCalledWith({ gist_id: "octo-1" });
  });

  it("throws when both gh and octokit fail", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.get.mockRejectedValue(new Error("not found"));

    await expect(readGist("missing")).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// updateGist
// ---------------------------------------------------------------------------

describe("updateGist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
  });

  it("uses gh CLI to update a gist when gh is available", async () => {
    mockExecFileResult({
      stdout: JSON.stringify({
        id: "abc123",
        html_url: "https://gist.github.com/abc123",
      }),
      stderr: "",
    });

    const result = await updateGist("abc123", sampleFiles());

    expect(result.id).toBe("abc123");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["api", "--method", "PATCH", "/gists/abc123"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("falls back to octokit when gh CLI is not available", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.update.mockResolvedValue({
      data: {
        id: "octo-1",
        html_url: "https://gist.github.com/octo-1",
      },
    });

    const result = await updateGist("octo-1", sampleFiles());

    expect(result.id).toBe("octo-1");
    expect(gists.update).toHaveBeenCalledWith(
      expect.objectContaining({
        gist_id: "octo-1",
        files: expect.objectContaining({
          "cat.yaml": { content: expect.any(String) },
          "catalog.lock.json": { content: expect.any(String) },
        }),
      }),
    );
  });

  it("throws when both gh and octokit fail", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.update.mockRejectedValue(new Error("update failed"));

    await expect(updateGist("bad", sampleFiles())).rejects.toThrow(
      /update failed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// findGistByDescription
// ---------------------------------------------------------------------------

describe("findGistByDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOctokit();
  });

  it("uses gh CLI to list gists and find matching description", async () => {
    const listData = JSON.stringify([
      { id: "gist-1", description: "other-thing" },
      { id: "gist-2", description: "catalog-default" },
      { id: "gist-3", description: "catalog-staging" },
    ]);
    mockExecFileResult({ stdout: listData, stderr: "" });

    const result = await findGistByDescription("catalog-default");

    expect(result).toEqual({ id: "gist-2", description: "catalog-default" });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["gist", "list", "--json"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns undefined when no gist matches via gh CLI", async () => {
    const listData = JSON.stringify([
      { id: "gist-1", description: "other-thing" },
    ]);
    mockExecFileResult({ stdout: listData, stderr: "" });

    const result = await findGistByDescription("catalog-default");

    expect(result).toBeUndefined();
  });

  it("falls back to octokit when gh CLI is not available", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.list.mockResolvedValue({
      data: [
        { id: "octo-1", description: "catalog-default" },
        { id: "octo-2", description: "other" },
      ],
    });

    const result = await findGistByDescription("catalog-default");

    expect(result).toEqual({ id: "octo-1", description: "catalog-default" });
    expect(gists.list).toHaveBeenCalled();
  });

  it("returns undefined via octokit when no gist matches", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.list.mockResolvedValue({
      data: [],
    });

    const result = await findGistByDescription("catalog-default");

    expect(result).toBeUndefined();
  });

  it("returns undefined when both gh and octokit fail", async () => {
    const error = new Error("gh not found") as Error & { code?: string };
    error.code = "ENOENT";
    mockExecFileResult({ error });

    gists.list.mockRejectedValue(new Error("list failed"));

    const result = await findGistByDescription("catalog-default");

    expect(result).toBeUndefined();
  });
});
