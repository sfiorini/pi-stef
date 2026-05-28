/**
 * S-507: Integration test — sf_team_followup in a non-git tmpdir with gitMode='off'.
 *
 * Verifies that followup with gitMode='off' doesn't throw assertIsGitRepo.
 * followup.ts calls runTaskWorkflow which already has the gitMode guard.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamFollowup } from "../../src/tools/followup";
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

function makeParentPlanFolder(repoRoot: string, parentSlug: string): string {
  const folder = planFolderPath(repoRoot, parentSlug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: Parent feature

**Description:** Parent feature.

**Stories:**
- **S-101 — Implement parent.** Write it.

**Approval Status:** approved
`,
  );
  return folder;
}

describe("sf_team_followup — no-git tmpdir with gitMode='off'", () => {
  it("succeeds without throwing; commitSha and prDescriptionPath are undefined", async () => {
    // tmpdir that is NOT a git repository
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-followup-no-git-"));
    const parentSlug = "2026-05-26-parent-plan";
    try {
      makeParentPlanFolder(repoRoot, parentSlug);

      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "planner") {
          return fakeRun(`Draft a single-file followup plan for: No-git followup

Brief:
Test brief.

## Plan

### M0: Do the followup thing

**Description:** Implement the followup.

**Acceptance Criteria:**
- [ ] Followup done.

**Stories:**
- **S-001 — Implement followup.** Write the code.
`);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        {
          title: "No-git followup",
          brief: "Test brief.",
          parentPlan: parentSlug,
          verifyCommand: false,
        },
        { repoRoot, gitMode: "off" },
      );

      expect(result.approved).toBe(true);
      expect(result.commitSha).toBeUndefined();
      expect(result.prDescriptionPath).toBeUndefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
