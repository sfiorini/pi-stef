import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createVerificationRunCache } from "@pi-stef/agent-workflows";
import type { AgentRun, TeamMember } from "../src/runtime/types";
import { runConfiguredVerification } from "../src/tools/verification-stage";

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

describe("sf-team verification agent mode", () => {
  it("dispatches a read-only verifier agent instead of command stages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-verification-agent-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: { test: "true" },
      }, null, 2));
      const prompts: string[] = [];
      const verifier: TeamMember = { role: "reviewer", model: "claude-opus-4-7", thinking: "high" };
      const spawnAgent = vi.fn(async (_member: TeamMember, task: { task: string; cwd?: string }) => {
        prompts.push(task.task);
        return fakeRun("VERIFICATION: PASS\nEvidence: npm test passed.");
      });

      await runConfiguredVerification({
        toolName: "sf_team_followup",
        cwd: root,
        phase: "after",
        verification: { timing: "after", mode: "agent", stages: "test" },
        agent: { member: verifier, spawnAgent },
      });

      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(prompts[0]).toContain("READ-ONLY verification agent");
      expect(prompts[0]).toContain("Do not edit files");
      expect(prompts[0]).toContain("npm run test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates agent verifier runs through the shared run cache", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-verification-agent-cache-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: { test: "true" },
      }, null, 2));
      const verifier: TeamMember = { role: "reviewer", model: "claude-opus-4-7", thinking: "high" };
      const spawnAgent = vi.fn(async () => fakeRun("VERIFICATION: PASS\nEvidence: npm test passed."));
      const cache = createVerificationRunCache();
      const request = {
        toolName: "sf_team_followup" as const,
        cwd: root,
        phase: "after" as const,
        verification: { timing: "after" as const, mode: "agent" as const, stages: "test" as const },
        agent: { member: verifier, spawnAgent },
        cache,
      };

      await runConfiguredVerification(request);
      await runConfiguredVerification(request);

      expect(spawnAgent).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when verifier output contains conflicting status lines", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-team-verification-agent-conflict-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: { test: "true" },
      }, null, 2));
      const verifier: TeamMember = { role: "reviewer", model: "claude-opus-4-7", thinking: "high" };
      const spawnAgent = vi.fn(async () => fakeRun("VERIFICATION: PASS\nEvidence...\nVERIFICATION: FAIL\nActually failed."));

      await expect(runConfiguredVerification({
        toolName: "sf_team_followup",
        cwd: root,
        phase: "after",
        verification: { timing: "after", mode: "agent", stages: "test" },
        agent: { member: verifier, spawnAgent },
      })).rejects.toThrow(/verifier agent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
