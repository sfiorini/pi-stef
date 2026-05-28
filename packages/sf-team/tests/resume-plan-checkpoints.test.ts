import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowCheckpointRuntime } from "@pi-stef/agent-workflows";

import { makeSpawnHelper, type ToolDeps } from "../src/tools/shared";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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

describe("checkpointed spawn helper", () => {
  it("skips a completed spawnText step on resume and returns the stored artifact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-plan-checkpoints-"));
    try {
      const slug = "2026-05-06-checkpointed-plan";
      const member: TeamMember = { role: "planner", model: "test-model" };
      const task: AgentTask = { task: "draft the plan" };
      const spawnAgent = vi.fn(async () => fakeRun("planner output v1"));
      const deps = {
        spawnAgent,
        runReviewLoop: vi.fn(),
        fetchJiraContext: vi.fn(),
      } as unknown as ToolDeps;

      const first = makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: false }),
      });
      await expect(first.spawnText(member, task, "planner failed")).resolves.toBe("planner output v1");
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      spawnAgent.mockImplementation(async () => fakeRun("planner output v2"));
      const resumed = makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: true }),
      });
      await expect(resumed.spawnText(member, task, "planner failed")).resolves.toBe("planner output v1");
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      const changedResume = makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: true }),
      });
      await expect(changedResume.spawnText(member, { task: "draft the changed plan" }, "planner failed")).resolves.toBe(
        "planner output v2",
      );
      expect(spawnAgent).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respawns a started-but-incomplete spawnText step with the same task prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-plan-started-"));
    try {
      const slug = "2026-05-06-started-plan";
      const member: TeamMember = { role: "planner", model: "test-model" };
      const task: AgentTask = { task: "draft after interruption" };
      const prompts: string[] = [];
      const spawnAgent = vi.fn(async (_member: TeamMember, received: AgentTask) => {
        prompts.push(received.task);
        return fakeRun("fresh output");
      });
      const deps = {
        spawnAgent,
        runReviewLoop: vi.fn(),
        fetchJiraContext: vi.fn(),
      } as unknown as ToolDeps;

      const checkpoints = createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: false });
      await checkpoints.recordStarted("spawnText:planner:1", { task: task.task, cwd: task.cwd });

      const resumed = makeSpawnHelper(deps, {
        checkpoints: createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: true }),
      });
      await expect(resumed.spawnText(member, task, "planner failed")).resolves.toBe("fresh output");
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(prompts).toEqual(["draft after interruption"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
