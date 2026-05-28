import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createWorkflowMetadata,
  emptyCheckpointStore,
  readCheckpointStore,
  readWorkflowMetadata,
  recordCheckpointCompleted,
  recordCheckpointStarted,
  recordCommitIntent,
  workflowCheckpointsPath,
  workflowMetadataPath,
  writeCheckpointStore,
  writeWorkflowMetadata,
} from "../src";

function tmp(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workflows-state-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("workflow metadata", () => {
  it("creates, writes, and reads workflow metadata atomically", async () => {
    const { root, dispose } = tmp();
    try {
      const now = new Date("2026-05-06T12:00:00.000Z");
      const metadata = createWorkflowMetadata({
        slug: "2026-05-06-example",
        folderPath: path.join(root, "ai_plan", "2026-05-06-example"),
        ownerTool: "sf_team_plan",
        currentTool: "sf_team_plan",
        phase: "planner",
        now,
      });

      await writeWorkflowMetadata(root, metadata);
      expect(existsSync(workflowMetadataPath(root, metadata.slug))).toBe(true);
      expect(existsSync(`${workflowMetadataPath(root, metadata.slug)}.tmp`)).toBe(false);

      const reread = await readWorkflowMetadata(root, metadata.slug);
      expect(reread).toMatchObject({
        schemaVersion: 1,
        slug: metadata.slug,
        ownerTool: "sf_team_plan",
        currentTool: "sf_team_plan",
        status: "running",
        phase: "planner",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        checkpoints: {},
        commitIntents: {},
      });
    } finally {
      dispose();
    }
  });
});

describe("checkpoint store", () => {
  it("records started, completed, and commit-intent state in checkpoints.json", async () => {
    const { root, dispose } = tmp();
    try {
      const startedAt = new Date("2026-05-06T12:00:00.000Z");
      const completedAt = new Date("2026-05-06T12:02:00.000Z");
      let store = emptyCheckpointStore("2026-05-06-example", startedAt);

      store = recordCheckpointStarted(store, {
        stepId: "planner",
        artifactPath: ".fh-workflow/artifacts/planner.md",
        inputFingerprint: "input-1",
        now: startedAt,
      });
      store = recordCheckpointCompleted(store, {
        stepId: "planner",
        outputFingerprint: "output-1",
        now: completedAt,
      });
      store = recordCommitIntent(store, {
        intentId: "planner#commit",
        stepId: "planner",
        cwd: root,
        message: "feat: planner",
        expectedSubject: "feat: planner",
        expectedTree: "tree",
        expectedParent: "parent",
        allowEmpty: false,
      });

      await writeCheckpointStore(root, store);
      expect(existsSync(workflowCheckpointsPath(root, store.slug))).toBe(true);
      expect(existsSync(`${workflowCheckpointsPath(root, store.slug)}.tmp`)).toBe(false);

      const raw = readFileSync(workflowCheckpointsPath(root, store.slug), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const reread = await readCheckpointStore(root, store.slug);
      expect(reread?.checkpoints.planner).toMatchObject({
        stepId: "planner",
        status: "completed",
        artifactPath: ".fh-workflow/artifacts/planner.md",
        inputFingerprint: "input-1",
        outputFingerprint: "output-1",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      });
      expect(reread?.commitIntents["planner#commit"]).toMatchObject({
        expectedTree: "tree",
        expectedParent: "parent",
      });
    } finally {
      dispose();
    }
  });
});
