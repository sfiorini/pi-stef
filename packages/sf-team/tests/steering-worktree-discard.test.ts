import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { captureWorktreeDiscardSummary, discardIsolatedWorktreeChanges } from "../src/steering/agent-control";
import type { ActiveAgentRecord } from "../src/steering/types";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeRepo(): { repoRoot: string; worktreePath: string; dispose: () => void } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "sf-team-discard-main-"));
  const worktreePath = `${repoRoot}-lane`;
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "a@b"]);
  git(repoRoot, ["config", "user.name", "tester"]);
  writeFileSync(path.join(repoRoot, ".gitignore"), ".env\n");
  writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "init"]);
  git(repoRoot, ["worktree", "add", "-q", "-b", "lane", worktreePath, "HEAD"]);
  return {
    repoRoot,
    worktreePath,
    dispose: () => {
      spawnSync("git", ["worktree", "remove", "-f", worktreePath], { cwd: repoRoot, encoding: "utf8" });
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function dirtyWorktree(worktreePath: string): void {
  writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n");
  writeFileSync(path.join(worktreePath, "new-file.txt"), "new\n");
  writeFileSync(path.join(worktreePath, ".env"), "ignored\n");
}

function agent(worktreePath: string): ActiveAgentRecord {
  return {
    id: "agent-1",
    role: "developer",
    label: "Developer S-101",
    workflowId: "workflow-1",
    startedAt: "2026-05-17T00:00:00.000Z",
    state: "running",
    promptSummary: "Implement story",
    promptHash: "hash",
    worktreePath,
  };
}

describe("steering worktree discard safety", () => {
  it("discards tracked and untracked isolated-worktree changes after confirmation while preserving ignored files", async () => {
    const repo = makeRepo();
    try {
      dirtyWorktree(repo.worktreePath);
      const confirm = vi.fn(async () => true);

      const result = await discardIsolatedWorktreeChanges({
        agent: agent(repo.worktreePath),
        repoRoot: repo.repoRoot,
        confirm,
      });

      expect(result.status).toBe("discarded");
      expect(confirm).toHaveBeenCalledOnce();
      expect(result.summary.trackedChanges.join("\n")).toContain("tracked.txt");
      expect(result.summary.untrackedFiles.join("\n")).toContain("new-file.txt");
      expect(result.summary.ignoredFiles.join("\n")).toContain(".env");
      expect(await readFile(path.join(repo.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
      expect(existsSync(path.join(repo.worktreePath, "new-file.txt"))).toBe(false);
      expect(existsSync(path.join(repo.worktreePath, ".env"))).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it("does not mutate the filesystem when the user declines discard", async () => {
    const repo = makeRepo();
    try {
      dirtyWorktree(repo.worktreePath);
      const result = await discardIsolatedWorktreeChanges({
        agent: agent(repo.worktreePath),
        repoRoot: repo.repoRoot,
        confirm: async () => false,
      });

      expect(result.status).toBe("rejected");
      expect(await readFile(path.join(repo.worktreePath, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(existsSync(path.join(repo.worktreePath, "new-file.txt"))).toBe(true);
      expect(existsSync(path.join(repo.worktreePath, ".env"))).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it("rejects the main repository worktree before asking for confirmation", async () => {
    const repo = makeRepo();
    try {
      const confirm = vi.fn(async () => true);

      await expect(discardIsolatedWorktreeChanges({
        agent: agent(repo.repoRoot),
        repoRoot: repo.repoRoot,
        confirm,
      })).rejects.toThrow(/main repository worktree/);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      repo.dispose();
    }
  });

  it("rejects an adversarial discard pointed at process.cwd()", async () => {
    const repo = makeRepo();
    try {
      await expect(captureWorktreeDiscardSummary(agent(process.cwd()), repo.repoRoot)).rejects.toThrow(/current process worktree/);
    } finally {
      repo.dispose();
    }
  });
});
