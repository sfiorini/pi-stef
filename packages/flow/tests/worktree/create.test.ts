import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorktree } from "../../src/worktree/create.js";
import { WorktreeError } from "../../src/worktree/validate.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(existsSync);

describe("createWorktree (flow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMocks(opts: { branchExists?: boolean; pathExists?: boolean } = {}) {
    let revParseCallCount = 0;

    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: any) => {
      const args = _args as string[];

      if (args[0] === "--version") {
        cb(null, { stdout: "git version 2.39.0", stderr: "" });
      } else if (args[0] === "status") {
        cb(null, { stdout: "", stderr: "" });
      } else if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        cb(null, { stdout: "true\n", stderr: "" });
      } else if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        cb(null, { stdout: "/Users/test/repo\n", stderr: "" });
      } else if (args[0] === "rev-parse" && args[1] === "--verify") {
        revParseCallCount++;
        if (revParseCallCount === 1 && opts.branchExists) {
          cb(null, { stdout: "abc123", stderr: "" });
        } else if (revParseCallCount === 1) {
          cb(new Error("not found"), { stdout: "", stderr: "" });
        } else {
          cb(null, { stdout: "def456\n", stderr: "" });
        }
      } else if (args[0] === "worktree" && args[1] === "add") {
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return {} as any;
    });

    if (opts.pathExists) {
      mockExistsSync.mockReturnValue(true);
    }
  }

  it("creates a worktree on flow/<slug> with flow-<slug> dir name (default prefix)", async () => {
    setupMocks();
    const result = await createWorktree({ slug: "add-auth" });
    expect(result.branchName).toBe("flow/add-auth");
    expect(result.worktreePath).toContain("flow-add-auth");
    expect(result.baseSha).toBe("def456");
  });

  it("accepts a custom branch prefix", async () => {
    setupMocks();
    const result = await createWorktree({ slug: "test", branchPrefix: "feature/" });
    expect(result.branchName).toBe("feature/test");
  });

  it("rejects invalid slug with special characters", async () => {
    await expect(createWorktree({ slug: "my feature!" })).rejects.toThrow(WorktreeError);
  });

  it("rejects slug with spaces", async () => {
    await expect(createWorktree({ slug: "my feature" })).rejects.toThrow(WorktreeError);
  });

  it("accepts slug with dots and hyphens", async () => {
    setupMocks();
    const result = await createWorktree({ slug: "my.feature-1.0" });
    expect(result.branchName).toBe("flow/my.feature-1.0");
  });

  it("throws when branch already exists", async () => {
    setupMocks({ branchExists: true });
    await expect(createWorktree({ slug: "existing" })).rejects.toThrow(WorktreeError);
  });
});
