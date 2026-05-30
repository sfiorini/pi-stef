import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process so no real processes are spawned
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

// ---------------------------------------------------------------------------
// Helper to wire up mock results
// ---------------------------------------------------------------------------

/** Simulate a successful execFile call. */
function mockSuccess(stdout: string, stderr = ""): void {
  mockedExecFile.mockImplementation(
    (..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(null, stdout, stderr);
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

/** Simulate an execFile call that fails with a spawn error (e.g. ENOENT). */
function mockSpawnError(code: string, message: string): void {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  mockedExecFile.mockImplementation(
    (..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(error, "", "");
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

/** Simulate an execFile call that exits with a non-zero code. */
function mockExitError(exitCode: number, stderr = ""): void {
  const error = new Error(`Command failed`) as Error & {
    status?: number;
  };
  error.status = exitCode;
  mockedExecFile.mockImplementation(
    (..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(error, "", stderr);
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import { checkAuth, getToken } from "../../src/sync/auth.js";

// ---------------------------------------------------------------------------
// checkAuth
// ---------------------------------------------------------------------------
describe("checkAuth", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns true when gh CLI is available and authenticated", async () => {
    // `gh auth status` exits 0 when authenticated
    mockSuccess("", "✓ Logged in to github.com");

    const result = await checkAuth();

    expect(result).toBe(true);
  });

  it("returns false when gh CLI is not found (ENOENT)", async () => {
    // `gh` binary doesn't exist on the system
    mockSpawnError("ENOENT", "spawn gh ENOENT");

    const result = await checkAuth();

    expect(result).toBe(false);
  });

  it("returns false when gh CLI is not authenticated", async () => {
    // `gh auth status` exits non-zero when not logged in
    mockExitError(1, "not logged in");

    const result = await checkAuth();

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getToken
// ---------------------------------------------------------------------------
describe("getToken", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("extracts token from gh auth token", async () => {
    mockSuccess("ghp_abc123token\n");

    const token = await getToken();

    expect(token).toBe("ghp_abc123token");
    // Should call gh first
    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("trims whitespace from gh auth token output", async () => {
    mockSuccess("  ghp_xyz789  \n");

    const token = await getToken();

    expect(token).toBe("ghp_xyz789");
  });

  it("falls back to GITHUB_TOKEN env when gh CLI is not available", async () => {
    mockSpawnError("ENOENT", "spawn gh ENOENT");

    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "env_github_token_123";

    try {
      const token = await getToken();
      expect(token).toBe("env_github_token_123");
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it("falls back to GITHUB_TOKEN env when gh auth token fails", async () => {
    // gh exists but is not authenticated
    mockExitError(1, "not logged in");

    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "fallback_token";

    try {
      const token = await getToken();
      expect(token).toBe("fallback_token");
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it("returns undefined when neither gh nor env var is available", async () => {
    mockSpawnError("ENOENT", "spawn gh ENOENT");

    const originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const token = await getToken();
      expect(token).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      }
    }
  });
});
