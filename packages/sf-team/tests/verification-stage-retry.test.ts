import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const { runVerificationStage } = await import("../src/tools/verification-stage");

function tempCwd(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "verification-stage-retry-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("runVerificationStage retry policy", () => {
  it("retries one transient verification failure and returns when the retry passes", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "first stdout", stderr: "first stderr" })
        .mockReturnValueOnce({ status: 0, signal: null, stdout: "second stdout", stderr: "" });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }, { maxAttempts: 2 }),
      ).not.toThrow();

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("retrying verification gate");
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("uses the reporter instead of console.error for retry notices when provided", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = {
      message: vi.fn(),
      clearMessage: vi.fn(),
      dispose: vi.fn(),
    };
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "first stdout", stderr: "first stderr" })
        .mockReturnValueOnce({ status: 0, signal: null, stdout: "second stdout", stderr: "" });

      expect(() =>
        runVerificationStage(
          "sf_team_test",
          root,
          { cmd: "npm", args: ["run", "test"] },
          { maxAttempts: 2, reporter },
        ),
      ).not.toThrow();

      expect(reporter.message).toHaveBeenCalledWith(
        expect.stringContaining("retrying verification gate"),
        expect.objectContaining({ level: "warning" }),
      );
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("throws after the retry also fails and reports the final attempt", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "first stdout", stderr: "first stderr" })
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "second stdout", stderr: "second stderr" });

      let thrown: Error | null = null;
      try {
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }, { maxAttempts: 2 });
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("attempt 2/2");
      expect(thrown!.message).toContain("second stderr");
      expect(thrown!.message).toContain("second stdout");
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("does not retry a spawn error because the command never started", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock.mockReturnValueOnce({
        status: null,
        signal: null,
        error: new Error("command not found"),
        stdout: "",
        stderr: "",
      });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "missing-command", args: [] }),
      ).toThrow(/spawn error/);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("defaults to a single attempt", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock.mockReturnValueOnce({ status: 1, signal: null, stdout: "stdout", stderr: "stderr" });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }),
      ).toThrow(/attempt 1\/1/);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("honors maxAttempts greater than two", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "one", stderr: "" })
        .mockReturnValueOnce({ status: 1, signal: null, stdout: "two", stderr: "" })
        .mockReturnValueOnce({ status: 0, signal: null, stdout: "three", stderr: "" });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }, { maxAttempts: 3 }),
      ).not.toThrow();

      expect(spawnSyncMock).toHaveBeenCalledTimes(3);
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("does not retry signal-terminated processes", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock.mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }, { maxAttempts: 2 }),
      ).toThrow(/signal SIGTERM/);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("treats invalid maxAttempts as the default single attempt", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = tempCwd();
    try {
      spawnSyncMock.mockReturnValueOnce({ status: 1, signal: null, stdout: "", stderr: "failed" });

      expect(() =>
        runVerificationStage("sf_team_test", root, { cmd: "npm", args: ["run", "test"] }, { maxAttempts: Number.NaN }),
      ).toThrow(/attempt 1\/1/);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});
