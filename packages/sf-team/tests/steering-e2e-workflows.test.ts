import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writePlanFolder } from "../src/plan/write";
import { followupSlug, slugify } from "../src/plan/slug";
import { createSfTeamFollowup } from "../src/tools/followup";
import { createSfTeamTask } from "../src/tools/task";
import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { createSteeringStore } from "../src/steering/store";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import type { SteeringDecision } from "../src/steering/types";

const APPROVED_BODY = `## Summary
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

const PARENT_PLAN = `# Plan

## Milestones

### M0: Existing parent

**Stories:**
- **S-001 - Existing parent story.** Already implemented.
`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "sf-team-steering-e2e-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeRun(finalText: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

function decision(instructionId: string): SteeringDecision {
  return {
    id: `decision-${instructionId}`,
    instructionId,
    decidedAt: "2026-05-17T00:00:01.000Z",
    kind: "apply-to-future",
    summary: "Apply guidance to the next safe boundary.",
    rationale: "The instruction is non-destructive and does not require current agent control.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    risks: [],
    activeAgentsVersion: 0,
    referencedAgentStates: {},
    referencedPlanHashes: {},
    requiresConfirmation: false,
    scopeKind: "workflow",
    guidanceText: `Future agents: incorporate guidance for instruction ${instructionId}.`,
  };
}

function makeSpawnAgent(root: string, instructionId: string) {
  let developerCalls = 0;
  return vi.fn(async (member: TeamMember, task: AgentTask) => {
    // Length-1 batches delegate to the legacy single-instruction decider
    // (backward-compat per milestone spec), which expects a raw
    // SteeringDecision JSON in the spawn output.
    if (member.role === "steering-decider") {
      return fakeRun(JSON.stringify(decision(instructionId)));
    }
    if (member.role === "planner") return fakeRun("task plan");
    if (member.role === "developer") {
      developerCalls += 1;
      const target = path.join(root, `steered-${developerCalls}.md`);
      writeFileSync(target, `developer ${developerCalls}\n`);
      spawnSync("git", ["add", path.basename(target)], { cwd: root });
      return fakeRun("developer made changes");
    }
    return fakeRun(APPROVED_BODY);
  });
}

async function seedInstruction(root: string, slug: string) {
  const planRoot = path.join(root, "ai_plan", slug);
  const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
  const instruction = await store.appendInstruction({
    workflowId: `workflow:${slug}`,
    planSlug: slug,
    source: "tool",
    text: "Use the steering inbox before spawning the next role agent.",
    priority: "normal",
  });
  return { store, instruction };
}

describe("steering e2e workflow drains", () => {
  it("sf_team_task drains queued steering at workflow start and records applied instructions", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Steered Task");
      const { store, instruction } = await seedInstruction(root, slug);
      const spawnAgent = makeSpawnAgent(root, instruction.id);
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const task = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await task(
        { title: "Steered Task", brief: "Make a tiny change.", verifyCommand: false, allowDirty: true },
        { repoRoot: root },
      );

      expect(result.approved).toBe(true);
      expect(spawnAgent.mock.calls[0][0].role).toBe("steering-decider");
      expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "applied" }]);
      expect(await store.listAppliedInstructions()).toMatchObject([
        { instructionId: instruction.id, decisionId: `decision-${instruction.id}` },
      ]);
    } finally {
      dispose();
    }
  });

  it("sf_team_followup uses the same steering drain path as task workflows", async () => {
    const { root, dispose } = makeRepo();
    try {
      const parentSlug = slugify("Parent Plan");
      await writePlanFolder(root, {
        kind: "five-file",
        slug: parentSlug,
        files: {
          "original-plan.md": PARENT_PLAN,
          "milestone-plan.md": PARENT_PLAN,
          "story-tracker.md": "# Story Tracker\n\n## Milestones\n\n### M0: Existing parent\n\n| Story | Description | Status | Notes |\n|-------|-------------|--------|-------|\n| S-001 | Existing parent story | completed | abc1234 |\n\n**Approval Status:** approved (abc1234)\n",
          "continuation-runbook.md": "n/a\n",
          "final-transcript.md": "n/a\n",
        },
      });
      const slug = followupSlug("Steered Followup");
      const { store, instruction } = await seedInstruction(root, slug);
      const spawnAgent = makeSpawnAgent(root, instruction.id);
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const followup = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await followup(
        {
          title: "Steered Followup",
          parentPlan: parentSlug,
          brief: "Make a tiny followup change.",
          verifyCommand: false,
          allowDirty: true,
        },
        { repoRoot: root },
      );

      expect(result.approved).toBe(true);
      expect(spawnAgent.mock.calls[0][0].role).toBe("steering-decider");
      expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "applied" }]);
      expect(await store.listAppliedInstructions()).toMatchObject([
        { instructionId: instruction.id, decisionId: `decision-${instruction.id}` },
      ]);
    } finally {
      dispose();
    }
  });
});
