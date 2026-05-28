import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { planFolderPath } from "../src/plan/paths";
import { createSfTeamImplement } from "../src/tools/implement";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { resolveDefaults } from "../src/config/load";

const APPROVED = `## Summary
ok
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: APPROVED`;

function fakeRun(text: string): AgentRun {
  return {
    state: "completed",
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
  };
}

function makeRepo(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-impl-par-story-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-04-parallel-stories";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: Parallel stories

**Stories:**
- **S-101 — story one.** Body.
- **S-102 — story two.** Body.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: Parallel stories

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | story one | pending | |
| S-102 | story two | pending | |

**Approval Status:** pending
`,
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
          storyWaves: [
            {
              id: "M1-W1",
              stories: ["S-101", "S-102"],
              maxParallel: 2,
              writeSets: { "S-101": ["s101.txt"], "S-102": ["s102.txt"] },
            },
          ],
        },
      },
    }),
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("sf_team_implement parallel stories", () => {
  it("runs strategy story lanes in isolated worktrees, commits them, then reviews the combined milestone", async () => {
    const { root, slug, dispose } = makeRepo();
    try {
      const developerCwds: string[] = [];
      const reviewerCwds: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const story = /story (S-\d+)/i.exec(task.task)?.[1] ?? "S-000";
          const cwd = task.cwd ?? root;
          developerCwds.push(cwd);
          writeFileSync(path.join(cwd, `${story}.txt`), `${story}\n`);
          spawnSync("git", ["add", `${story}.txt`], { cwd });
          return fakeRun(`implemented ${story}`);
        }
        reviewerCwds.push(task.cwd ?? root);
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({}) },
      );

      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0]).toMatchObject({ id: "M1", approved: true });
      expect(new Set(developerCwds).size).toBe(2);
      expect(reviewerCwds).toHaveLength(1);
      expect(reviewerCwds[0]).not.toBe(result.worktreePath);
      expect(developerCwds.every((cwd) => !existsSync(cwd))).toBe(true);
      expect(existsSync(reviewerCwds[0])).toBe(false);

      const log = spawnSync("git", ["log", "--oneline", "--all"], {
        cwd: result.worktreePath,
        encoding: "utf8",
      }).stdout;
      expect(log).toContain("feat(S-101): story one");
      expect(log).toContain("feat(S-102): story two");
      expect(log).toContain("feat(M1): Parallel stories");

      const callsAfterFirstRun = spawnAgent.mock.calls.length;
      const resumed = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({}) },
      );
      expect(resumed.milestones).toHaveLength(0);
      expect(spawnAgent).toHaveBeenCalledTimes(callsAfterFirstRun);
    } finally {
      dispose();
    }
  });
});
