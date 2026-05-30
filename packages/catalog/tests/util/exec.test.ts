import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  execCommand,
  piInstall,
  piUninstall,
  type ExecResult,
} from "../../src/util/exec.js";

// ---------------------------------------------------------------------------
// Mock child_process so no real processes are spawned
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

/** Helper to cast the mocked execFile for typing convenience. */
const mockedExecFile = vi.mocked(execFile);

/**
 * Wire up the mock to call back with the given result.
 * We use the Node-style (error, stdout, stderr) callback convention.
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

// ---------------------------------------------------------------------------
// execCommand
// ---------------------------------------------------------------------------

describe("execCommand", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns stdout and stderr on success", async () => {
    mockExecFileResult({ stdout: "hello world", stderr: "" });

    const result: ExecResult = await execCommand("echo", ["hello"]);

    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(mockedExecFile).toHaveBeenCalledOnce();
  });

  it("passes the command and arguments to execFile", async () => {
    mockExecFileResult({ stdout: "ok", stderr: "" });

    await execCommand("pi", ["install", "some-pkg"]);

    expect(mockedExecFile).toHaveBeenCalledWith(
      "pi",
      ["install", "some-pkg"],
      expect.any(Object), // SpawnOptions
      expect.any(Function), // callback
    );
  });

  it("captures stderr output", async () => {
    mockExecFileResult({ stdout: "out", stderr: "warning msg" });

    const result = await execCommand("some-cmd", []);

    expect(result.stderr).toBe("warning msg");
  });

  it("throws on non-zero exit code with stdout/stderr attached", async () => {
    const error = new Error("Command failed with exit code 1") as Error & {
      code?: string;
    };
    error.code = "ERR_CHILD_PROCESS_EXIT_CODE";
    mockExecFileResult({ error, stdout: "partial", stderr: "err detail" });

    await expect(execCommand("fail-cmd", [])).rejects.toMatchObject({
      message: expect.stringContaining("exit code"),
      stdout: "partial",
      stderr: "err detail",
    });
  });

  it("respects timeout option", async () => {
    mockExecFileResult({ stdout: "done", stderr: "" });

    await execCommand("cmd", [], { timeout: 5000 });

    expect(mockedExecFile).toHaveBeenCalledWith(
      "cmd",
      [],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it("throws a timeout error when the process times out", async () => {
    const error = new Error("spawn timed out") as Error & {
      code?: string;
      killed?: boolean;
    };
    error.code = "ETIMEDOUT";
    error.killed = true;
    mockExecFileResult({ error, stdout: "", stderr: "" });

    await expect(
      execCommand("slow-cmd", [], { timeout: 100 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
  });

  it("uses the default shell when no shell option is provided", async () => {
    mockExecFileResult({ stdout: "", stderr: "" });

    await execCommand("ls", []);

    // execFile should be called without an explicit shell override
    const options = (mockedExecFile.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options.shell).toBeUndefined();
  });

  it("passes the shell option through to execFile when set", async () => {
    mockExecFileResult({ stdout: "", stderr: "" });

    await execCommand("echo", ["hello"], { shell: "/bin/zsh" });

    const options = (mockedExecFile.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options.shell).toBe("/bin/zsh");
  });

  it("converts Buffer stdout/stderr to strings", async () => {
    // When execFile is called without encoding, Node passes Buffer objects.
    // Verify the implementation converts them to strings.
    mockedExecFile.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (..._args: any[]) => {
        const cb = _args[_args.length - 1] as (
          err: Error | null,
          stdout: Buffer,
          stderr: Buffer,
        ) => void;
        cb(
          null,
          Buffer.from("buffer output"),
          Buffer.from("buffer error"),
        );
        return undefined as unknown as ReturnType<typeof execFile>;
      },
    );

    const result = await execCommand("cmd", []);
    expect(typeof result.stdout).toBe("string");
    expect(result.stdout).toBe("buffer output");
    expect(typeof result.stderr).toBe("string");
    expect(result.stderr).toBe("buffer error");
    expect(result.exitCode).toBe(0);
  });

  it("extracts numeric exit code from child process error status", async () => {
    // Child process errors have a numeric `status` property (not on ErrnoException).
    const error = new Error("Command failed") as Error & {
      status?: number;
      code?: string;
    };
    error.status = 42;
    error.code = "ERR_CHILD_PROCESS_EXIT_CODE";
    mockExecFileResult({ error, stdout: "out", stderr: "err" });

    await expect(execCommand("cmd", [])).rejects.toMatchObject({
      exitCode: 42,
      stdout: "out",
      stderr: "err",
    });
  });
});

// ---------------------------------------------------------------------------
// piInstall
// ---------------------------------------------------------------------------

describe("piInstall", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("calls pi install with the given source", async () => {
    mockExecFileResult({ stdout: "installed", stderr: "" });

    const result = await piInstall("https://github.com/example/pkg");

    expect(result.stdout).toBe("installed");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "pi",
      ["install", "https://github.com/example/pkg"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes timeout option through to execCommand", async () => {
    mockExecFileResult({ stdout: "ok", stderr: "" });

    await piInstall("https://github.com/example/pkg", { timeout: 10000 });

    const options = (mockedExecFile.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options.timeout).toBe(10000);
  });

  it("propagates install errors", async () => {
    const error = new Error("install failed") as Error & { code?: string };
    error.code = "ERR_CHILD_PROCESS_EXIT_CODE";
    mockExecFileResult({ error, stdout: "", stderr: "not found" });

    await expect(
      piInstall("https://github.com/example/bad-pkg"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// piUninstall
// ---------------------------------------------------------------------------

describe("piUninstall", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("calls pi uninstall with the given package name", async () => {
    mockExecFileResult({ stdout: "uninstalled", stderr: "" });

    const result = await piUninstall("my-skill");

    expect(result.stdout).toBe("uninstalled");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "pi",
      ["uninstall", "my-skill"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes timeout option through to execCommand", async () => {
    mockExecFileResult({ stdout: "ok", stderr: "" });

    await piUninstall("my-skill", { timeout: 8000 });

    const options = (mockedExecFile.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options.timeout).toBe(8000);
  });

  it("propagates uninstall errors", async () => {
    const error = new Error("uninstall failed") as Error & { code?: string };
    error.code = "ERR_CHILD_PROCESS_EXIT_CODE";
    mockExecFileResult({ error, stdout: "", stderr: "error removing" });

    await expect(piUninstall("bad-skill")).rejects.toThrow();
  });
});
