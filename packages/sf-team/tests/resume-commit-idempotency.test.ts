import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowMetadata, writeWorkflowMetadata } from "@pi-stef/agent-workflows";

import { planFolderPath } from "../src/plan/paths";
import { createSfTeamImplement } from "../src/tools/implement";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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

function completed(text: string): AgentRun {
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

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

function seedRepo(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "resume-commit-idempotency-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "a@b"]);
  git(root, ["config", "user.name", "tester"]);
  writeFileSync(path.join(root, "README.md"), "x\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  const slug = "2026-05-06-idempotent-commit";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "### M1: One\n\n**Stories:**\n- **S-101 — Do one.** Body.\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(path.join(folder, "story-tracker.md"), tracker("pending"));
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function tracker(status: "pending" | "completed"): string {
  return `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | Do one | ${status} | |

**Approval Status:** ${status === "completed" ? "approved" : "pending"}
`;
}

describe("resume commit idempotency", () => {
  it("does not create a duplicate milestone commit when resuming after the commit already exists", async () => {
    const { root, slug, dispose } = seedRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          writeFileSync(path.join(task.cwd ?? root, "impl.txt"), "done\n");
          git(task.cwd ?? root, ["add", "impl.txt"]);
          return completed("implemented");
        }
        return completed(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      await tool({ slug, useWorktree: false, verifyCommand: false }, { repoRoot: root });
      const firstCount = git(root, ["log", "--oneline", "--grep=feat(M1): One"]).split("\n").filter(Boolean).length;
      expect(firstCount).toBe(1);

      writeFileSync(path.join(planFolderPath(root, slug), "story-tracker.md"), tracker("pending"));
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: planFolderPath(root, slug),
        ownerTool: "sf_team_implement",
        currentTool: "sf_team_implement",
        phase: "commit",
      }));

      await tool({ resume: slug, useWorktree: false, verifyCommand: false }, { repoRoot: root });
      const secondCount = git(root, ["log", "--oneline", "--grep=feat(M1): One"]).split("\n").filter(Boolean).length;
      expect(secondCount).toBe(1);
    } finally {
      dispose();
    }
  });

  // The "appendFollowupSection" idempotency case was removed alongside
  // the helper itself: sf_team_followup now writes its own plan folder
  // (with its own pr-description.md) and never mutates the parent's
  // pr-description, so there is no append path to test.
});
