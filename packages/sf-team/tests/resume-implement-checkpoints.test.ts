import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowCheckpointRuntime } from "@pi-stef/agent-workflows";

import { makeSpawnHelper, type ToolDeps } from "../src/tools/shared";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

function run(text: string): AgentRun {
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

describe("implement resume checkpoints", () => {
  it("reuses a completed developer artifact without respawning", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-implement-checkpoints-"));
    try {
      const member: TeamMember = { role: "developer", model: "test" };
      const task: AgentTask = { task: "implement M1" };
      const spawnAgent = vi.fn(async () => run("implemented once"));
      const deps = { spawnAgent, runReviewLoop: vi.fn(), fetchJiraContext: vi.fn() } as unknown as ToolDeps;

      await makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug: "slug", resumeMode: false }),
      }).spawnText(member, task, "developer failed");

      const resumed = makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug: "slug", resumeMode: true }),
      });
      await expect(resumed.spawnText(member, task, "developer failed")).resolves.toBe("implemented once");
      expect(spawnAgent).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
