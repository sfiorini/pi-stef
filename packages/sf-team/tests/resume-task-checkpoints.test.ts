import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkflowCheckpointRuntime } from "@pi-stef/agent-workflows";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const { runVerificationStage } = await import("../src/tools/verification-stage");

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, signal: null, stdout: "", stderr: "" });
});

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("checkpointed verification stage", () => {
  it("skips a completed verification stage on resume until the command fingerprint changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "resume-task-checkpoints-"));
    try {
      const slug = "2026-05-06-task-verification";
      const stage = { cmd: "npm", args: ["run", "test"] };
      const first = createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: false });
      runVerificationStage("sf_team_task", root, stage, { checkpoints: first });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);

      const resumed = createWorkflowCheckpointRuntime({ repoRoot: root, slug, resumeMode: true });
      runVerificationStage("sf_team_task", root, stage, { checkpoints: resumed });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);

      const otherCwd = path.join(root, "subdir");
      runVerificationStage("sf_team_task", otherCwd, stage, { checkpoints: resumed });
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
