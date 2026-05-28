/**
 * S-M45 — Tests for `tryDeleteBranch` and the M4 lane-branch cleanup
 * wiring. Pins these scenarios:
 *   1. Milestone-lane happy path: aggregate + lane + merge → cleanup
 *      with mergeTarget=aggregateBranch deletes the lane.
 *   2. Story-lane happy path (R4 P2): aggregate + milestone + story
 *      lanes; merge story into milestone (NOT into aggregate); cleanup
 *      with mergeTarget=milestoneBranch deletes. Same call with
 *      mergeTarget=aggregateBranch returns lane_branch_not_ancestor —
 *      proves milestone-as-target is necessary.
 *   3. keep_lane_branches=true: branch survives; no `git branch -d`.
 *   4. Concurrent-worktree failure: pre-create a worktree on the lane
 *      branch so `git branch -d` fails with checked-out, returns
 *      `lane_branch_kept`.
 *   5. Ref-moved: change the tip after capturing expectedSha → returns
 *      `lane_branch_ref_moved`.
 *   6. Not-ancestor: lane points to a divergent commit → returns
 *      `lane_branch_not_ancestor`.
 *   7. Already-deleted: pre-delete the branch → returns
 *      `lane_branch_already_deleted`.
 *   8. Invalid name (`feat;rm`): returns `lane_branch_invalid_name`
 *      and NO git command was invoked.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { tryDeleteBranch } from "../src/worktree/cleanup";

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-lane-cleanup-"));
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "a@b"], root);
  git(["config", "user.name", "tester"], root);
  writeFileSync(path.join(root, "README.md"), "hi\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function commitOnBranch(root: string, branch: string, fileName: string, content: string): string {
  git(["checkout", "-q", "-b", branch], root);
  writeFileSync(path.join(root, fileName), content);
  git(["add", fileName], root);
  git(["commit", "-q", "-m", `feat(${branch}): ${fileName}`], root);
  const sha = git(["rev-parse", "--verify", "HEAD"], root).stdout.trim();
  return sha;
}

function commitOnExistingBranch(root: string, branch: string, fileName: string, content: string): string {
  git(["checkout", "-q", branch], root);
  writeFileSync(path.join(root, fileName), content);
  git(["add", fileName], root);
  git(["commit", "-q", "-m", `feat(${branch}): ${fileName}`], root);
  const sha = git(["rev-parse", "--verify", "HEAD"], root).stdout.trim();
  return sha;
}

describe("S-M45 tryDeleteBranch happy paths", () => {
  it("milestone-lane happy path: deletes the lane branch when expectedSha matches and is ancestor of aggregateBranch", () => {
    const { root, dispose } = makeRepo();
    try {
      // Aggregate branch
      const aggregateBranch = "auto/2026-05-08-demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      // Milestone lane branch — note: production uses laneBranchNamespace()
      // which flattens the aggregate name's slashes. So the lane is in a
      // SIBLING namespace, not a child of the aggregate ref. The two
      // `auto/2026-05-08-demo` and `auto-2026-05-08-demo/...` refs do not
      // collide in the refs/heads/ filesystem.
      const lane = "auto-2026-05-08-demo/milestones/M1";
      const laneSha = commitOnBranch(root, lane, "m1.txt", "m1\n");
      // Merge lane into aggregate
      git(["checkout", "-q", aggregateBranch], root);
      const merge = git(["merge", "--no-ff", "-m", `merge ${lane}`, lane], root);
      expect(merge.status).toBe(0);

      const result = tryDeleteBranch({
        branchName: lane,
        repoRoot: root,
        expectedSha: laneSha,
        mergeTarget: aggregateBranch,
      });
      expect(result).toEqual({ deleted: true });
      const stillThere = git(["show-ref", "--verify", "--quiet", `refs/heads/${lane}`], root);
      expect(stillThere.status).not.toBe(0);
    } finally {
      dispose();
    }
  });

  it("story-lane happy path with mergeTarget=milestoneBranch (R4 P2): deletes the story lane", () => {
    const { root, dispose } = makeRepo();
    try {
      const aggregateBranch = "auto/demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      // Milestone lane: namespace flattened from aggregate.
      const milestoneBranch = "auto-demo/milestones/M1";
      git(["checkout", "-q", "-b", milestoneBranch], root);
      // Story lane: namespace flattened from milestone branch.
      const storyBranch = "auto-demo-milestones-M1/stories/S-101";
      const storySha = commitOnBranch(root, storyBranch, "s1.txt", "s1\n");
      // Merge story into milestone (NOT into aggregate yet)
      git(["checkout", "-q", milestoneBranch], root);
      const merge = git(["merge", "--no-ff", "-m", `merge ${storyBranch} into M1`, storyBranch], root);
      expect(merge.status).toBe(0);

      // Cleanup with mergeTarget=milestoneBranch should delete.
      const ok = tryDeleteBranch({
        branchName: storyBranch,
        repoRoot: root,
        expectedSha: storySha,
        mergeTarget: milestoneBranch,
      });
      expect(ok).toEqual({ deleted: true });
    } finally {
      dispose();
    }
  });

  it("story-lane regression: cleanup with mergeTarget=aggregateBranch returns lane_branch_not_ancestor (R4 P2 pin)", () => {
    const { root, dispose } = makeRepo();
    try {
      const aggregateBranch = "auto/demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      const milestoneBranch = "auto-demo/milestones/M1";
      git(["checkout", "-q", "-b", milestoneBranch], root);
      const storyBranch = "auto-demo-milestones-M1/stories/S-101";
      const storySha = commitOnBranch(root, storyBranch, "s1.txt", "s1\n");
      git(["checkout", "-q", milestoneBranch], root);
      git(["merge", "--no-ff", "-m", `merge ${storyBranch}`, storyBranch], root);

      // Story is merged into milestone, but aggregate has not yet absorbed
      // milestone. So the story sha is NOT an ancestor of aggregate.
      const result = tryDeleteBranch({
        branchName: storyBranch,
        repoRoot: root,
        expectedSha: storySha,
        mergeTarget: aggregateBranch,
      });
      expect(result).toMatchObject({ kind: "lane_branch_not_ancestor", lane: storyBranch });
      // Branch survives.
      const stillThere = git(["show-ref", "--verify", "--quiet", `refs/heads/${storyBranch}`], root);
      expect(stillThere.status).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe("S-M42 / S-M44: keep_lane_branches=true skips cleanup; lane survives", () => {
  /**
   * Acceptance criterion 11: with `parallel.keep_lane_branches: true`,
   * the lane branch survives. Acceptance criterion 12 says
   * `warnings` collects DELETE FAILURES — opt-in retention is NOT a
   * failure, so no warning is emitted.
   *
   * Approach: spawn a real sf_team_implement run in parallel mode against
   * a 2-story fixture, with `parallel.keep_lane_branches=true`. Drive the
   * developer/reviewer agents via stub spawnAgent. After rollup, assert:
   *   1. all lane branches still exist
   *   2. result.warnings is undefined or empty (no synthetic warning)
   *
   * Cross-checked: a sibling run with `keep_lane_branches=false` deletes
   * the lanes and leaves no warnings.
   */
  async function runParallelImplement(
    keep: boolean,
  ): Promise<{
    laneBranches: string[];
    surviving: string[];
    warnings: import("../src/worktree/cleanup").BranchCleanupWarning[] | undefined;
    root: string;
    dispose: () => void;
  }> {
    const { resolveDefaults } = await import("../src/config/load");
    const { planFolderPath } = await import("../src/plan/paths");
    const { createSfTeamImplement } = await import("../src/tools/implement");
    const root = mkdtempSync(path.join(tmpdir(), `ct-keep-lane-${keep ? "on" : "off"}-`));
    const dispose = () => rmSync(root, { recursive: true, force: true });
    git(["init", "-q", "-b", "main"], root);
    git(["config", "user.email", "a@b"], root);
    git(["config", "user.name", "tester"], root);
    writeFileSync(path.join(root, "README.md"), "hi\n");
    git(["add", "."], root);
    git(["commit", "-q", "-m", "init"], root);
    const slug = `2026-05-08-keep-lane-${keep ? "on" : "off"}`;
    const folder = planFolderPath(root, slug);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, "milestone-plan.md"),
      `# Plan\n\n### M1: One\n\n**Stories:**\n- **S-101 — make a change.** Body.\n- **S-102 — make another change.** Body.\n`,
    );
    writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
    writeFileSync(
      path.join(folder, "story-tracker.md"),
      `### M1: One\n\n| Story | Description | Status | Notes |\n|-------|-------------|--------|-------|\n| S-101 | make a change | pending | |\n| S-102 | make another change | pending | |\n\n**Approval Status:** pending\n`,
    );
    writeFileSync(
      path.join(folder, "execution-strategy.json"),
      JSON.stringify({
        version: 1,
        maxParallelMilestones: 1,
        maxParallelStoriesPerMilestone: 2,
        milestoneWaves: [{ id: "W1", milestones: ["M1"], maxParallel: 1 }],
        stories: {
          M1: {
            maxParallelStories: 2,
            storyWaves: [{
              id: "M1-W1",
              stories: ["S-101", "S-102"],
              maxParallel: 2,
              writeSets: { "S-101": ["m1.txt"], "S-102": ["m2.txt"] },
            }],
          },
        },
      }),
    );

    const { vi } = await import("vitest");
    const { default: fakeRunFn } = await import("./helpers/fakeRun" as any).catch(() => ({ default: undefined as any }));
    void fakeRunFn;
    const APPROVED_RESPONSE = `## Summary\nok\n## Findings\n### P0\n- None.\n### P1\n- None.\n### P2\n- None.\n### P3\n- None.\n## Verdict\nVERDICT: APPROVED`;
    const fakeRun = (text: string) => ({
      state: "completed" as const,
      pid: 1,
      parentPid: process.pid,
      childPids: [],
      metrics: { startedAtMs: Date.now() },
      exitCode: 0,
      finalText: text,
      events: [],
      eventsCompacted: false,
      eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
      toolCalls: [],
      stderrTail: "",
    });
    const spawnAgent = vi.fn(async (member: any, task: any) => {
      if (member.role === "developer") {
        const cwd = task.cwd ?? root;
        const story = /story (S-\d+)/i.exec(task.task)?.[1] ?? "S-000";
        const file = story === "S-101" ? "m1.txt" : "m2.txt";
        writeFileSync(path.join(cwd, file), `${story}\n`);
        spawnSync("git", ["add", file], { cwd });
        return fakeRun(`implemented ${story}`);
      }
      return fakeRun(APPROVED_RESPONSE);
    });
    const { runReviewLoop } = await import("../src/review/loop");
    const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

    const result = await tool(
      { slug, mode: "all-milestones", useWorktree: true, branchPrefix: "impl/", verifyCommand: false, pauseBetweenMilestones: false },
      {
        repoRoot: root,
        configDefaults: resolveDefaults({
          parallel: { max_milestones: 1, max_stories_per_milestone: 2, keep_lane_branches: keep },
        }),
        toolName: "sf_team_implement",
      },
    );

    // Lane branches we expect to have been created during the run.
    // laneBranchNamespace flattens slashes in the aggregate branch name; for
    // `impl/<slug>` that gives `impl-<slug>`. For story lanes the namespace
    // is the milestone branch flattened.
    const aggFlat = `impl/${slug}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    const milestoneLane = `${aggFlat}/milestones/M1`;
    const milestoneFlat = milestoneLane.replace(/[^A-Za-z0-9._-]+/g, "-");
    const laneBranches = [milestoneLane, `${milestoneFlat}/stories/S-101`, `${milestoneFlat}/stories/S-102`];
    const surviving = laneBranches.filter((b) => git(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], result.worktreePath ?? root).status === 0);
    return { laneBranches, surviving, warnings: result.warnings, root, dispose };
  }

  it("keep_lane_branches=true: every lane branch survives, result.warnings stays empty", async () => {
    const { laneBranches, surviving, warnings, dispose } = await runParallelImplement(true);
    try {
      expect(surviving.length).toBe(laneBranches.length);
      expect(warnings ?? []).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("keep_lane_branches=false (default): no lane branches survive, no warnings", async () => {
    const { surviving, warnings, dispose } = await runParallelImplement(false);
    try {
      expect(surviving.length).toBe(0);
      expect(warnings ?? []).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe("S-M45 tryDeleteBranch failure modes", () => {
  it("ref-moved: another commit on the lane after expectedSha capture → lane_branch_ref_moved", () => {
    const { root, dispose } = makeRepo();
    try {
      const aggregateBranch = "auto/demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      const lane = "auto-demo/milestones/M1";
      const expectedSha = commitOnBranch(root, lane, "m1.txt", "m1\n");
      git(["checkout", "-q", aggregateBranch], root);
      git(["merge", "--no-ff", "-m", `merge ${lane}`, lane], root);
      // Move the lane tip forward.
      commitOnExistingBranch(root, lane, "m1b.txt", "m1b\n");

      const result = tryDeleteBranch({
        branchName: lane,
        repoRoot: root,
        expectedSha,
        mergeTarget: aggregateBranch,
      });
      expect(result).toMatchObject({ kind: "lane_branch_ref_moved", lane });
      const stillThere = git(["show-ref", "--verify", "--quiet", `refs/heads/${lane}`], root);
      expect(stillThere.status).toBe(0);
    } finally {
      dispose();
    }
  });

  it("not-ancestor (divergent tip): expected sha not in mergeTarget → lane_branch_not_ancestor", () => {
    const { root, dispose } = makeRepo();
    try {
      const aggregateBranch = "auto/demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      const lane = "auto-demo/milestones/M1";
      const expectedSha = commitOnBranch(root, lane, "m1.txt", "m1\n");
      // DON'T merge into aggregate.
      const result = tryDeleteBranch({
        branchName: lane,
        repoRoot: root,
        expectedSha,
        mergeTarget: aggregateBranch,
      });
      expect(result).toMatchObject({ kind: "lane_branch_not_ancestor", lane });
    } finally {
      dispose();
    }
  });

  it("already-deleted: ref doesn't exist → lane_branch_already_deleted", () => {
    const { root, dispose } = makeRepo();
    try {
      const result = tryDeleteBranch({
        branchName: "auto/demo/milestones/M99",
        repoRoot: root,
        expectedSha: "0000000000000000000000000000000000000000",
        mergeTarget: "main",
      });
      expect(result).toMatchObject({ kind: "lane_branch_already_deleted", lane: "auto/demo/milestones/M99" });
    } finally {
      dispose();
    }
  });

  it("invalid-name (`feat;rm`): returns lane_branch_invalid_name and NO git destructive call fires", () => {
    const { root, dispose } = makeRepo();
    try {
      const result = tryDeleteBranch({
        branchName: "feat;rm",
        repoRoot: root,
        expectedSha: "0000000000000000000000000000000000000000",
        mergeTarget: "main",
      });
      expect(result).toMatchObject({ kind: "lane_branch_invalid_name", lane: "feat;rm" });
      // Nothing was created or destroyed.
      const branches = git(["branch", "--list"], root).stdout;
      expect(branches).not.toContain("feat;rm");
    } finally {
      dispose();
    }
  });

  it("concurrent-worktree: lane is checked out in another worktree → branch -d fails, returns lane_branch_kept", () => {
    const { root, dispose } = makeRepo();
    try {
      const aggregateBranch = "auto/demo";
      git(["checkout", "-q", "-b", aggregateBranch], root);
      const lane = "auto-demo/milestones/M1";
      const expectedSha = commitOnBranch(root, lane, "m1.txt", "m1\n");
      git(["checkout", "-q", aggregateBranch], root);
      git(["merge", "--no-ff", "-m", `merge ${lane}`, lane], root);
      // Pre-create a worktree on the lane branch — `git branch -d` refuses
      // to delete a branch that's checked out elsewhere.
      const wtPath = path.join(root, ".worktrees", "lane-wt");
      mkdirSync(path.dirname(wtPath), { recursive: true });
      const wtAdd = git(["worktree", "add", wtPath, lane], root);
      expect(wtAdd.status, wtAdd.stderr).toBe(0);
      try {
        const result = tryDeleteBranch({
          branchName: lane,
          repoRoot: root,
          expectedSha,
          mergeTarget: aggregateBranch,
        });
        expect(result).toMatchObject({ kind: "lane_branch_kept", lane });
        // Branch survives because the worktree is still attached.
        const stillThere = git(["show-ref", "--verify", "--quiet", `refs/heads/${lane}`], root);
        expect(stillThere.status).toBe(0);
      } finally {
        git(["worktree", "remove", "--force", wtPath], root);
      }
    } finally {
      dispose();
    }
  });
});
