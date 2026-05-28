import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowMetadata, writeWorkflowMetadata } from "@pi-stef/agent-workflows";

import { resolveDefaults } from "../src/config/load";
import { planFolderPath } from "../src/plan/paths";
import { createSfTeamImplement } from "../src/tools/implement";
import { ensureLaneWorktree } from "../src/worktree/create";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}

function initRepo(root: string): void {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "a@b"]);
  git(root, ["config", "user.name", "tester"]);
  writeFileSync(path.join(root, "README.md"), "x\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
}

function writeCompletedPlan(root: string, slug: string): string {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "original-plan.md"), "# Original\n");
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Plan\n\n### M1: Done\n\n**Stories:**\n- **S-101 - done.** Body.\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(path.join(folder, "final-transcript.md"), "# Transcript\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: Done

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | done | completed | abc123 |

**Approval Status:** APPROVED
`,
  );
  return folder;
}

function cleanupRepo(root: string): void {
  rmSync(`${root}-worktrees`, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

describe("resume worktree safety", () => {
  it("refuses to reuse an attached lane worktree when it is dirty", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-worktree-safety-"));
    try {
      initRepo(root);

      const first = await ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
      });
      writeFileSync(path.join(first.worktreePath, "dirty.txt"), "dirty\n");

      await expect(ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
      })).rejects.toThrow(/dirty attached worktree/);
    } finally {
      cleanupRepo(root);
    }
  });

  it("allows dirty attached lane worktree reuse only when explicitly resuming", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-worktree-dirty-reuse-"));
    try {
      initRepo(root);

      const first = await ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
      });
      writeFileSync(path.join(first.worktreePath, "dirty.txt"), "dirty\n");

      const reused = await ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
        allowDirtyAttached: true,
      });
      expect(reused.reused).toBe(true);
      expect(realpathSync(reused.worktreePath)).toBe(realpathSync(first.worktreePath));
    } finally {
      cleanupRepo(root);
    }
  });

  it("warns when a dirty attached resume worktree differs from the expected base", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-worktree-base-warning-"));
    try {
      initRepo(root);

      const first = await ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
      });
      writeFileSync(path.join(first.worktreePath, "dirty.txt"), "dirty\n");

      writeFileSync(path.join(root, "later.txt"), "later\n");
      git(root, ["add", "later.txt"]);
      git(root, ["commit", "-q", "-m", "later"]);

      const reporter = {
        message: vi.fn(() => "warning-id"),
        clearMessage: vi.fn(),
        dispose: vi.fn(),
      };
      const reused = await ensureLaneWorktree({
        repoRoot: root,
        slug: "lane",
        branchName: "implement/demo/M1",
        baseRef: "HEAD",
        allowDirtyAttached: true,
        reporter,
      });

      expect(reused.reused).toBe(true);
      expect(reporter.message).toHaveBeenCalledWith(
        expect.stringContaining("differs from expected base"),
        { level: "warning" },
      );
    } finally {
      cleanupRepo(root);
    }
  });

  it("sf_team_implement resume reuses the dirty attached worktree on the non-parallel path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-worktree-nonparallel-"));
    const worktreePath = `${root}-attached`;
    try {
      initRepo(root);
      const slug = "2026-05-07-nonparallel-resume";
      const folder = writeCompletedPlan(root, slug);
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "sf_team_implement",
        currentTool: "sf_team_implement",
        phase: "running",
      }));
      git(root, ["worktree", "add", "-b", `impl/${slug}`, worktreePath, "HEAD"]);
      writeFileSync(path.join(worktreePath, "interrupted.txt"), "dirty\n");

      const tool = createSfTeamImplement({
        spawnAgent: (async () => {
          throw new Error("no agent should run for a completed resumed plan");
        }) as never,
      });
      const result = await tool(
        { resume: slug, useWorktree: true, branchPrefix: "impl/", verifyCommand: false },
        {
          repoRoot: root,
          configDefaults: resolveDefaults({ parallel: { enabled: false } }),
        },
      );

      expect(result.milestones).toHaveLength(0);
      expect(result.branch).toBe(`impl/${slug}`);
      expect(realpathSync(result.worktreePath!)).toBe(realpathSync(worktreePath));
    } finally {
      try {
        git(root, ["worktree", "remove", "--force", worktreePath]);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      cleanupRepo(root);
    }
  });
});
