import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { planFolderPath } from "../src/plan/paths";
import { applySteeringBacktrack, planCommitReverts, type CommitLedgerEntry } from "../src/steering/backtrack";
import { createSteeringDrain } from "../src/steering/drain";
import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { createSteeringStore } from "../src/steering/store";
import type { SteeringDecision, SteeringInstruction } from "../src/steering/types";

function instruction(): SteeringInstruction {
  return {
    id: "instruction-1",
    workflowId: "workflow-1",
    receivedAt: "2026-05-17T00:00:00.000Z",
    source: "tool",
    text: "Change completed story S-101.",
    priority: "urgent",
    status: "queued",
  };
}

function decision(patch: Partial<SteeringDecision> = {}): SteeringDecision {
  return {
    id: "decision-1",
    instructionId: "instruction-1",
    decidedAt: "2026-05-17T00:00:01.000Z",
    kind: "backtrack-completed-work",
    summary: "Replay S-101",
    rationale: "The completed story is affected.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: ["S-101"],
    affectedFiles: ["a.txt"],
    risks: [],
    activeAgentsVersion: 0,
    referencedAgentStates: {},
    referencedPlanHashes: {},
    requiresConfirmation: true,
    ...patch,
  };
}

function makePlan(): { root: string; slug: string; folder: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "sf-team-backtrack-"));
  const slug = "2026-05-17-backtrack";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Plan\n\n### M1: One\n\n**Stories:**\n- **S-101 - first.** Body.\n- **S-102 - second.** Body.\n");
  writeFileSync(path.join(folder, "final-transcript.md"), "# Final Transcript\n");
  writeFileSync(path.join(folder, "story-tracker.md"), `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | first | completed | abc111 |
| S-102 | second | completed | abc222 |

**Approval Status:** approved (abc222)
`);
  writeFileSync(path.join(folder, "execution-strategy.json"), JSON.stringify({
    version: 1,
    maxParallelMilestones: 1,
    maxParallelStoriesPerMilestone: 1,
    milestoneWaves: [{ id: "W1", milestones: ["M1"], maxParallel: 1 }],
    stories: {
      M1: {
        maxParallelStories: 1,
        storyWaves: [
          { id: "M1-W1", stories: ["S-101"], maxParallel: 1 },
          { id: "M1-W2", stories: ["S-102"], dependsOn: ["M1-W1"], maxParallel: 1 },
        ],
      },
    },
  }));
  return { root, slug, folder, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("steering backtrack", () => {
  it("declines completed-story replay without mutating tracker or transcript", async () => {
    const plan = makePlan();
    try {
      const before = await readFile(path.join(plan.folder, "story-tracker.md"), "utf8");
      const result = await applySteeringBacktrack({
        repoRoot: plan.root,
        slug: plan.slug,
        workflowId: "workflow-1",
        instruction: instruction(),
        decision: decision(),
        confirmCompletedWork: async () => false,
      });

      expect(result.status).toBe("rejected");
      expect(await readFile(path.join(plan.folder, "story-tracker.md"), "utf8")).toBe(before);
      expect(await readFile(path.join(plan.folder, "final-transcript.md"), "utf8")).toBe("# Final Transcript\n");
    } finally {
      plan.dispose();
    }
  });

  it("declines completed-milestone replay without mutating tracker", async () => {
    const plan = makePlan();
    try {
      const before = await readFile(path.join(plan.folder, "story-tracker.md"), "utf8");
      const result = await applySteeringBacktrack({
        repoRoot: plan.root,
        slug: plan.slug,
        workflowId: "workflow-1",
        instruction: instruction(),
        decision: decision({ affectedStories: [], affectedMilestones: ["M1"] }),
        confirmCompletedWork: async () => false,
      });

      expect(result.status).toBe("rejected");
      expect(await readFile(path.join(plan.folder, "story-tracker.md"), "utf8")).toBe(before);
    } finally {
      plan.dispose();
    }
  });

  it("marks active in-dev story amendments pending instead of needs-rework", async () => {
    const plan = makePlan();
    try {
      writeFileSync(path.join(plan.folder, "story-tracker.md"), `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | first | in-dev | started |

**Approval Status:** pending
`);
      const result = await applySteeringBacktrack({
        repoRoot: plan.root,
        slug: plan.slug,
        workflowId: "workflow-1",
        instruction: instruction(),
        decision: decision({
          kind: "amend-plan",
          requiresConfirmation: false,
          planPatchRequired: false,
          affectedStories: ["S-101"],
        }),
      });

      expect(result.status).toBe("applied");
      expect(await readFile(path.join(plan.folder, "story-tracker.md"), "utf8")).toContain(
        "| S-101 | first | pending | Superseded By Steering decision-1: prior in-dev (started) |",
      );
    } finally {
      plan.dispose();
    }
  });

  it("marks replay stories as needs-rework and preserves superseded completion notes after confirmation", async () => {
    const plan = makePlan();
    try {
      const result = await applySteeringBacktrack({
        repoRoot: plan.root,
        slug: plan.slug,
        workflowId: "workflow-1",
        instruction: instruction(),
        decision: decision(),
        confirmCompletedWork: async () => true,
      });

      expect(result.status).toBe("applied");
      const tracker = await readFile(path.join(plan.folder, "story-tracker.md"), "utf8");
      expect(tracker).toContain("| S-101 | first | needs-rework | Superseded By Steering decision-1: prior completed (abc111) |");
      expect(tracker).toContain("| S-102 | second | needs-rework | Superseded By Steering decision-1: prior completed (abc222) |");
      expect(tracker).toContain("**Approval Status:** needs-rework (superseded by steering decision-1)");
      expect(await readFile(path.join(plan.folder, "final-transcript.md"), "utf8")).toContain("Steering Amendment");
    } finally {
      plan.dispose();
    }
  });

  it("regenerates execution strategy when a steering amendment changes plan structure", async () => {
    const plan = makePlan();
    try {
      const result = await applySteeringBacktrack({
        repoRoot: plan.root,
        slug: plan.slug,
        workflowId: "workflow-1",
        instruction: { ...instruction(), text: "Add a new constraint to the plan." },
        decision: decision({
          kind: "amend-plan",
          affectedStories: [],
          planPatchRequired: true,
          requiresConfirmation: false,
          amendedUserFacingPlanText: "New constraint added by steering.",
        }),
      });

      expect(result.status).toBe("applied");
      expect(result.planChanged).toBe(true);
      expect(result.executionStrategyChanged).toBe(true);
      expect(await readFile(path.join(plan.folder, "milestone-plan.md"), "utf8")).toContain("New constraint added by steering.");
      const strategy = JSON.parse(await readFile(path.join(plan.folder, "execution-strategy.json"), "utf8")) as { maxParallelMilestones: number };
      expect(strategy.maxParallelMilestones).toBe(1);
    } finally {
      plan.dispose();
    }
  });

  it("plans owned revert commits but flags interleaved user-authored commits as uncertain", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-revert-"));
    try {
      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "user.email", "a@b"]);
      git(root, ["config", "user.name", "tester"]);
      writeFileSync(path.join(root, "a.txt"), "base\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-q", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);
      writeFileSync(path.join(root, "a.txt"), "sf-team\n");
      git(root, ["commit", "-am", "feat(S-101): first"]);
      const owned = git(root, ["rev-parse", "HEAD"]);
      writeFileSync(path.join(root, "user.txt"), "user\n");
      git(root, ["add", "user.txt"]);
      git(root, ["commit", "-q", "-m", "user-authored"]);
      const head = git(root, ["rev-parse", "HEAD"]);
      const ledger: CommitLedgerEntry = {
        workflowId: "workflow-1",
        storyId: "S-101",
        commitSha: owned,
        baseSha: base,
        headSha: head,
        writeScope: ["a.txt"],
      };

      const plan = await planCommitReverts({
        repoRoot: root,
        workflowId: "workflow-1",
        entries: [ledger],
        storyIds: ["S-101"],
      });

      expect(plan.ownedCommits).toEqual([]);
      expect(plan.uncertain[0].reason).toMatch(/unrecorded commit/);
      expect(plan.question).toContain("Commit ownership is uncertain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not route non-plan active-agent decisions through backtracking just because they reference stories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-drain-non-plan-"));
    try {
      const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(root), expectedRoot: root });
      const queued = await store.appendInstruction({
        workflowId: "workflow-1",
        source: "tool",
        text: "Restart only the active story worker.",
        priority: "urgent",
      });
      const applyPlanDecision = vi.fn();
      const drain = createSteeringDrain({
        workflowId: "workflow-1",
        workflowKind: "implement",
        store,
        applyPlanDecision,
        decide: async ({ instruction }) => decision({
          instructionId: instruction.id,
          kind: "restart-running-agents",
          targetAgents: ["agent-1"],
          affectedStories: ["S-101"],
          earliestReplayPoint: { storyId: "S-101", reason: "future boundary only" },
          requiresConfirmation: false,
        }),
      });

      await drain("explicit-steer-wake");

      expect(applyPlanDecision).not.toHaveBeenCalled();
      expect(await store.listInstructions()).toMatchObject([{ id: queued.id, status: "applied" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
