import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveDefaults } from "../src/config/load";
import { planFolderPath } from "../src/plan/paths";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { createSfTeamImplement } from "../src/tools/implement";

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
  const root = mkdtempSync(path.join(tmpdir(), "ct-impl-par-mile-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-04-parallel-milestones";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: One

**Stories:**
- **S-101 — one.** Body.

### M2: Two

**Stories:**
- **S-201 — two.** Body.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | one | pending | |

**Approval Status:** pending

### M2: Two

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-201 | two | pending | |

**Approval Status:** pending
`,
  );
  writeFileSync(
    path.join(folder, "execution-strategy.json"),
    JSON.stringify({
      version: 1,
      maxParallelMilestones: 2,
      maxParallelStoriesPerMilestone: 1,
      milestoneWaves: [{ id: "W1", milestones: ["M1", "M2"], maxParallel: 2 }],
      stories: {
        M1: {
          maxParallelStories: 1,
          storyWaves: [{ id: "M1-W1", stories: ["S-101"], maxParallel: 1, writeSets: { "S-101": ["m1.txt"] } }],
        },
        M2: {
          maxParallelStories: 1,
          storyWaves: [{ id: "M2-W1", stories: ["S-201"], maxParallel: 1, writeSets: { "S-201": ["m2.txt"] } }],
        },
      },
    }),
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("sf_team_implement parallel milestones", () => {
  it("starts independent milestone lanes in the same strategy batch concurrently", async () => {
    const { root, slug, dispose } = makeRepo();
    try {
      const startedDevelopers: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const story = /story (S-\d+)/i.exec(task.task)?.[1] ?? "S-000";
          startedDevelopers.push(story);
          await waitUntil(() => startedDevelopers.length >= 2, "both milestone story developers to start");
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `${story}.txt`), `${story}\n`);
          spawnSync("git", ["add", `${story}.txt`], { cwd });
          return fakeRun(`implemented ${story}`);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "all-milestones",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ parallel: { max_milestones: 2 } }) },
      );

      expect(new Set(startedDevelopers)).toEqual(new Set(["S-101", "S-201"]));
      expect(result.milestones.map((milestone) => milestone.id)).toEqual(["M1", "M2"]);
      const log = spawnSync("git", ["log", "--oneline"], {
        cwd: result.worktreePath,
        encoding: "utf8",
      }).stdout;
      expect(log).toContain("merge M1 into");
      expect(log).toContain("merge M2 into");
    } finally {
      dispose();
    }
  });
});
