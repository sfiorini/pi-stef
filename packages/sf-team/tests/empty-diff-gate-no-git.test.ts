/**
 * S-521: Tests that the empty-diff gate works correctly in no-git mode.
 *
 * In no-git mode, the developer's output text is used as evidence of changes
 * (no git staging available). A developer writing output text should NOT
 * trigger EmptyDiffError.
 *
 * Also validates that EmptyDiffError is still thrown in git mode when there's
 * truly no staged diff (to ensure git mode behavior isn't regressed).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamImplement } from "../src/tools/implement";
import { planFolderPath } from "../src/plan/paths";
import type { AgentRun } from "../src/runtime/types";

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

const DEVELOPER_OUTPUT_WITH_CHANGES = `I have implemented the feature.

## Changes

- Modified \`src/feature.ts\`: added the core logic
- Modified \`tests/feature.test.ts\`: added unit tests

## TDD proof

### Tests added
- \`tests/feature.test.ts::should work\` - tests the core behavior

### Red
\`\`\`
FAIL tests/feature.test.ts
\`\`\`

### Implementation
- Added the implementation in feature.ts

### Green
\`\`\`
PASS tests/feature.test.ts
\`\`\`
`;

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
  writeFileSync(path.join(folder, "original-plan.md"), "# Original\n");
}

describe("S-521: empty-diff gate in no-git mode", () => {
  it("no-git mode: developer output text is used as evidence; EmptyDiffError is NOT thrown", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-emptydiff-ngt-"));
    const slug = "2026-05-26-empty-diff-gate";
    try {
      makePlanFolder(repoRoot, slug);

      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "developer") {
          // Developer writes output with description of changes (no actual git staging)
          return fakeRun(DEVELOPER_OUTPUT_WITH_CHANGES);
        }
        // Reviewer approves
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      // Should NOT throw EmptyDiffError even though no files are staged
      const result = await tool(
        { slug, useWorktree: false, verifyCommand: false },
        { repoRoot, gitMode: "off" },
      );

      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0]!.approved).toBe(true);
      // No commit in no-git mode
      expect(result.milestones[0]!.commitSha).toBeUndefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("no-git mode: works even when developer output is minimal (bypasses empty-diff check)", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-emptydiff-ngt2-"));
    const slug = "2026-05-26-empty-diff-minimal";
    try {
      makePlanFolder(repoRoot, slug);

      const spawnAgent = vi.fn(async () => {
        return fakeRun(APPROVED); // Minimal output that looks like just approval
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      // Should NOT throw EmptyDiffError in no-git mode regardless of output content
      const result = await tool(
        { slug, useWorktree: false, verifyCommand: false },
        { repoRoot, gitMode: "off" },
      );

      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0]!.approved).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
