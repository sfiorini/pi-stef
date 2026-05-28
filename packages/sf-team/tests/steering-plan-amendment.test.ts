import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { planFolderPath } from "../src/plan/paths";
import { applySteeringBacktrack } from "../src/steering/backtrack";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import type { SpawnAgentReturning } from "../src/tools/shared";
import type { SteeringDecision, SteeringInstruction } from "../src/steering/types";

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

function instruction(): SteeringInstruction {
  return {
    id: "instruction-1",
    workflowId: "workflow-1",
    receivedAt: "2026-05-17T00:00:00.000Z",
    source: "tool",
    text: "Replace old architecture detail with patched detail.",
    priority: "normal",
    status: "queued",
  };
}

function decision(): SteeringDecision {
  return {
    id: "decision-1",
    instructionId: "instruction-1",
    decidedAt: "2026-05-17T00:00:01.000Z",
    kind: "amend-plan",
    summary: "Patch the plan.",
    rationale: "The plan needs an amended architecture note.",
    planPatchRequired: true,
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
  };
}

describe("steering plan amendment", () => {
  it("uses the existing plan patch revision pipeline for steering amendments", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-plan-amend-"));
    const slug = "2026-05-17-amend";
    const folder = planFolderPath(root, slug);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "milestone-plan.md"), [
      "# Plan",
      "",
      "## Architecture",
      "old architecture detail",
      "",
      "### M1: One",
      "",
      "#### Stories",
      "- **S-101 - first.** Body.",
      "",
    ].join("\n"));
    writeFileSync(path.join(folder, "story-tracker.md"), `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | first | pending | |

**Approval Status:** pending
`);
    writeFileSync(path.join(folder, "final-transcript.md"), "# Final Transcript\n");
    const patch = JSON.stringify({
      operations: [{
        op: "replace_within_section",
        target: { topLevelHeading: "Architecture" },
        anchor: "old architecture detail",
        body: "patched architecture detail",
      }, {
        op: "append_to_section",
        target: { milestoneId: "M1", section: "Stories" },
        body: "- **S-102 - second.** Body.\n",
      }],
    });
    const spawnText = vi.fn(async (_member: TeamMember, _task: AgentTask) => patch);
    const sp: SpawnAgentReturning = {
      spawn: vi.fn(async () => fakeRun("unused")),
      spawnText: spawnText as never,
    };
    const transcriptRecords: string[] = [];

    try {
      const result = await applySteeringBacktrack({
        repoRoot: root,
        slug,
        workflowId: "workflow-1",
        instruction: instruction(),
        decision: decision(),
        planner: { role: "planner", model: "planner-model" },
        sp,
        transcript: {
          setPhase: () => undefined,
          folder: () => folder,
          record: async (entry) => {
            transcriptRecords.push(entry.label);
            return undefined;
          },
        },
      });

      expect(result.status).toBe("applied");
      expect(result.planChanged).toBe(true);
      expect(spawnText).toHaveBeenCalledOnce();
      expect((spawnText.mock.calls[0][1] as AgentTask).task).toContain("Revise this steering milestone plan amendment");
      expect(await readFile(path.join(folder, "milestone-plan.md"), "utf8")).toContain("patched architecture detail");
      expect(await readFile(path.join(folder, "story-tracker.md"), "utf8")).toContain("| S-102 | second. | pending | |");
      expect(transcriptRecords).toContain("revision-patch");
      expect(transcriptRecords).toContain("patch-applied");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
