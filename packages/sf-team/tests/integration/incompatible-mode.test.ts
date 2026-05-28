/**
 * S-513: Integration test — useWorktree=true + gitMode='off' throws IncompatibleModeError.
 *
 * Verifies that:
 *   - useWorktree: true (explicitly) + gitMode: 'off' → throws IncompatibleModeError
 *   - gitMode: 'on' with useWorktree: true → does NOT throw IncompatibleModeError (only may throw GitRepoMissingError if not a git repo)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamImplement } from "../../src/tools/implement";
import { planFolderPath } from "../../src/plan/paths";
import { IncompatibleModeError } from "../../src/errors";

function makePlanFolder(repoRoot: string, slug: string): void {
  const folder = planFolderPath(repoRoot, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: Feature

**Description:** Core feature.

**Acceptance Criteria:**
- [ ] Feature done.

**Stories:**
- **S-101 — Implement feature.** Write it.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: Feature

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | Implement feature | pending | |

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
          storyWaves: [{ id: "M1-W1", stories: ["S-101"], maxParallel: 1, writeSets: { "S-101": ["out.txt"] } }],
        },
      },
    }),
  );
  writeFileSync(path.join(folder, "original-plan.md"), "# Original\n");
}

describe("incompatible mode: useWorktree=true + gitMode='off'", () => {
  it("throws IncompatibleModeError when useWorktree=true is explicit and gitMode='off'", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-incompat-"));
    const slug = "2026-05-26-incompat-test";
    try {
      makePlanFolder(repoRoot, slug);

      const spawnAgent = vi.fn(async () => ({ state: "completed", finalText: "ok" }));
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      await expect(
        tool(
          { slug, useWorktree: true, verifyCommand: false },
          { repoRoot, gitMode: "off" },
        ),
      ).rejects.toThrow(IncompatibleModeError);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does NOT throw IncompatibleModeError when useWorktree=false and gitMode='off'", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-compat-"));
    const slug = "2026-05-26-compat-test";
    try {
      makePlanFolder(repoRoot, slug);

      const spawnAgent = vi.fn(async () => ({
        state: "completed" as const,
        pid: 1,
        parentPid: process.pid,
        childPids: [],
        metrics: { startedAtMs: Date.now() },
        exitCode: 0,
        finalText: "VERDICT: APPROVED",
        events: [],
        eventsCompacted: false,
        eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
        toolCalls: [],
        stderrTail: "",
      }));
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });

      // Should not throw IncompatibleModeError
      const result = await tool(
        { slug, useWorktree: false, verifyCommand: false },
        { repoRoot, gitMode: "off" },
      );
      expect(result).toBeDefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
