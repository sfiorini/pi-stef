/**
 * S-503: Integration test — sf_team_implement in a non-git tmpdir with gitMode='off'.
 *
 * Verifies:
 *   - Call succeeds without throwing (no assertIsGitRepo error)
 *   - All milestones are approved
 *   - commitSha on each milestone is undefined (no commit in no-git mode)
 *   - result.prDescriptionPath is undefined (no PR in no-git mode)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamImplement } from "../../src/tools/implement";
import { planFolderPath } from "../../src/plan/paths";
import type { AgentRun } from "../../src/runtime/types";

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

function makePlanFolder(repoRoot: string, slug: string): void {
  const folder = planFolderPath(repoRoot, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: Implement feature

**Description:** Core feature.

**Acceptance Criteria:**
- [ ] Feature done.

**Stories:**
- **S-101 — Write the code.** Implement it.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: Implement feature

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | Write the code | pending | |

**Approval Status:** pending
`,
  );
  writeFileSync(
    path.join(folder, "execution-strategy.json"),
    JSON.stringify({
      version: 1,
      maxParallelMilestones: 1,
      maxParallelStoriesPerMilestone: 1,
      milestoneWaves: [{ id: "W1", milestones: ["M1"], maxParallel: 1 }],
      stories: {
        M1: {
          maxParallelStories: 1,
          storyWaves: [
            {
              id: "M1-W1",
              stories: ["S-101"],
              maxParallel: 1,
              writeSets: { "S-101": ["output.txt"] },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    path.join(folder, "original-plan.md"),
    "# Original plan\n",
  );
}

describe("sf_team_implement — no-git tmpdir with gitMode='off'", () => {
  it("succeeds without throwing; all milestones approved; commitSha undefined; prDescriptionPath undefined", async () => {
    // tmpdir that is NOT a git repository
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-impl-no-git-"));
    const slug = "2026-05-26-no-git-implement";
    try {
      makePlanFolder(repoRoot, slug);

      const spawnAgent = vi.fn(async (_member: { role: string }) => {
        // developer and reviewer both return approval
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        {
          slug,
          useWorktree: false,
          verifyCommand: false,
        },
        { repoRoot, gitMode: "off" },
      );

      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0]!.approved).toBe(true);
      expect(result.milestones[0]!.commitSha).toBeUndefined();
      expect(result.prDescriptionPath).toBeUndefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
