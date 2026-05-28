import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowMetadata, FIVE_FILE_NAMES, workflowCheckpointsPath, writeWorkflowMetadata } from "@pi-stef/agent-workflows";

import { resolveDefaults } from "../src/config/load";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { createSfTeamAuto } from "../src/tools/auto";
import { resolveToolResume } from "../src/tools/resume";

describe("auto resume ownership", () => {
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

  function git(cwd: string, args: string[]): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  }

  function makeGitRepo(): { root: string; dispose: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), "resume-auto-tool-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "a@b"]);
    git(root, ["config", "user.name", "tester"]);
    writeFileSync(path.join(root, "README.md"), "x\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  }

  function writeFiveFilePlan(root: string, slug: string): void {
    const folder = path.join(root, "ai_plan", slug);
    mkdirSync(folder, { recursive: true });
    for (const name of FIVE_FILE_NAMES) {
      writeFileSync(path.join(folder, name), `# ${name}\n`);
    }
  }

  function writeCompletedPlan(root: string, slug: string): void {
    const folder = path.join(root, "ai_plan", slug);
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
  }

  function writePendingParallelPlan(root: string, slug: string): string {
    const folder = path.join(root, "ai_plan", slug);
    mkdirSync(folder, { recursive: true });
    const milestonePlan = `# Plan

### M1: Parallel resume

**Stories:**
- **S-101 - story one.** Body.
- **S-102 - story two.** Body.
`;
    writeFileSync(path.join(folder, "original-plan.md"), milestonePlan);
    writeFileSync(path.join(folder, "milestone-plan.md"), milestonePlan);
    writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
    writeFileSync(path.join(folder, "final-transcript.md"), "# Transcript\n");
    writeFileSync(
      path.join(folder, "story-tracker.md"),
      `### M1: Parallel resume

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
    return folder;
  }

  function writeCheckpointSteps(root: string, slug: string, stepIds: string[]): void {
    const target = workflowCheckpointsPath(root, slug);
    mkdirSync(path.dirname(target), { recursive: true });
    const now = "2026-05-07T12:00:00.000Z";
    writeFileSync(target, `${JSON.stringify({
      schemaVersion: 1,
      slug,
      updatedAt: now,
      checkpoints: Object.fromEntries(stepIds.map((stepId) => [stepId, {
        stepId,
        status: "completed",
        startedAt: now,
        completedAt: now,
      }])),
      commitIntents: {},
    }, null, 2)}\n`);
  }

  it("accepts auto-owned metadata only when the invoked owner is sf_team_auto", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-auto-"));
    try {
      const slug = "2026-05-06-auto-owned";
      const folder = path.join(root, "ai_plan", slug);
      mkdirSync(folder, { recursive: true });
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "sf_team_auto",
        currentTool: "sf_team_implement",
        phase: "implement",
      }));

      await expect(resolveToolResume({
        repoRoot: root,
        toolName: "sf_team_auto",
        input: { resume: slug },
        normalField: "title",
      })).resolves.toMatchObject({ target: { slug }, metadata: { ownerTool: "sf_team_auto" } });
      await expect(resolveToolResume({
        repoRoot: root,
        toolName: "sf_team_implement",
        input: { resume: slug },
        normalField: "slug",
      })).rejects.toThrow(/owned by sf_team_auto.*sf_team_implement/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts metadata-less auto folders with plan and implementation checkpoints", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-auto-checkpoints-"));
    try {
      const slug = "2026-05-07-auto-missing-metadata";
      writeFiveFilePlan(root, slug);
      writeCheckpointSteps(root, slug, [
        "spawnText:planner:1",
        "spawnText:reviewer:1",
        "spawnText:developer-M1:1",
        "spawnText:reviewer-M1:1",
        "spawnText:developer-M2:1",
      ]);

      await expect(resolveToolResume({
        repoRoot: root,
        toolName: "sf_team_auto",
        input: { resume: slug },
        normalField: "title",
      })).resolves.toMatchObject({
        target: { slug },
        ownership: { kind: "auto-checkpoint-recovery" },
        legacy: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the plan phase and resumes implement when the plan folder already exists", async () => {
    const { root, dispose } = makeGitRepo();
    try {
      const slug = "2026-05-07-auto-resume-implement";
      const folder = path.join(root, "ai_plan", slug);
      writeCompletedPlan(root, slug);
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "sf_team_auto",
        currentTool: "sf_team_implement",
        phase: "running",
      }));

      const spawnAgent = vi.fn(async () => {
        throw new Error("planner/researcher/developer should not run for a completed resumed plan");
      });
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never });
      const result = await tool(
        { resume: slug, verifyCommand: false },
        {
          repoRoot: root,
          configDefaults: resolveDefaults({
            auto: { use_worktree: false },
            parallel: { enabled: false },
          }),
        },
      );

      expect(result.slug).toBe(slug);
      expect(result.planRounds).toBe(0);
      expect(result.implement.milestones).toHaveLength(0);
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("skips plan and reuses dirty attached parallel worktrees when auto resumes implementation", async () => {
    const { root, dispose } = makeGitRepo();
    const aggregateWorktree = `${root}-aggregate`;
    const milestoneWorktree = `${root}-milestone`;
    try {
      const slug = "2026-05-07-auto-resume-parallel";
      const folder = writePendingParallelPlan(root, slug);
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "sf_team_auto",
        currentTool: "sf_team_implement",
        phase: "running",
      }));

      const aggregateBranch = `auto/${slug}`;
      const milestoneBranch = `${aggregateBranch.replace(/[^A-Za-z0-9._-]+/g, "-")}/milestones/M1`;
      git(root, ["worktree", "add", "-b", aggregateBranch, aggregateWorktree, "HEAD"]);
      git(root, ["worktree", "add", "-b", milestoneBranch, milestoneWorktree, "HEAD"]);
      writeFileSync(path.join(aggregateWorktree, "interrupted-aggregate.txt"), "dirty\n");
      writeFileSync(path.join(milestoneWorktree, "interrupted-milestone.txt"), "dirty\n");

      const roles: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        roles.push(member.role);
        if (member.role === "researcher" || member.role === "planner") {
          throw new Error(`${member.role} should not run when auto resumes an implementable plan folder`);
        }
        if (member.role === "developer") {
          const storyId = /Implement story (S-\d+)/.exec(task.task)?.[1] ?? `S-${roles.length}`;
          const cwd = task.cwd ?? root;
          const file = `${storyId}.txt`;
          writeFileSync(path.join(cwd, file), `${storyId}\n`);
          git(cwd, ["add", file]);
          return fakeRun(`implemented ${storyId}`);
        }
        return fakeRun(APPROVED);
      });
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never });
      const result = await tool(
        { resume: slug, verifyCommand: false, verification: { timing: "off" } },
        {
          repoRoot: root,
          configDefaults: resolveDefaults({
            auto: { use_worktree: true },
            parallel: { enabled: true },
          }),
        },
      );

      expect(result.planRounds).toBe(0);
      expect(result.implement.milestones).toHaveLength(1);
      expect(result.implement.branch).toBe(aggregateBranch);
      expect(realpathSync(result.implement.worktreePath!)).toBe(realpathSync(aggregateWorktree));
      expect(roles).not.toContain("researcher");
      expect(roles).not.toContain("planner");
      expect(roles.filter((role) => role === "developer")).toHaveLength(2);
      expect(roles.filter((role) => role === "reviewer").length).toBeGreaterThanOrEqual(1);
    } finally {
      for (const worktree of [milestoneWorktree, aggregateWorktree]) {
        try {
          git(root, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
      rmSync(`${root}-worktrees`, { recursive: true, force: true });
      dispose();
    }
  });
});
