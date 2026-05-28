import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertResumeOwnership,
  createWorkflowMetadata,
  FIVE_FILE_NAMES,
  resolvePlanTarget,
  workflowCheckpointsPath,
  writeWorkflowMetadata,
} from "../src";

function fixture(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "resume-target-"));
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function createPlanFolder(root: string, slug: string): string {
  const folder = path.join(root, "ai_plan", slug);
  mkdirSync(folder, { recursive: true });
  return folder;
}

function writeCheckpointSteps(root: string, slug: string, stepIds: string[]): void {
  const target = workflowCheckpointsPath(root, slug);
  mkdirSync(path.dirname(target), { recursive: true });
  const now = "2026-05-07T12:00:00.000Z";
  writeFileSync(target, `${JSON.stringify({
    schemaVersion: 1,
    slug,
    updatedAt: now,
    checkpoints: Object.fromEntries(stepIds.map((stepId) => [stepId, {
      stepId,
      status: "completed",
      startedAt: now,
      completedAt: now,
    }])),
    commitIntents: {},
  }, null, 2)}\n`);
}

describe("resume target resolution", () => {
  it("resolves slug, absolute path, and relative path targets to the same plan folder", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-resume-demo";
      const folder = createPlanFolder(root, slug);

      await expect(resolvePlanTarget({ repoRoot: root, target: slug })).resolves.toMatchObject({
        slug,
        folderPath: folder,
        targetKind: "slug",
      });
      await expect(resolvePlanTarget({ repoRoot: root, target: folder })).resolves.toMatchObject({
        slug,
        folderPath: folder,
        targetKind: "absolute-path",
      });
      await expect(resolvePlanTarget({ repoRoot: root, target: path.join("ai_plan", slug) })).resolves.toMatchObject({
        slug,
        folderPath: folder,
        targetKind: "relative-path",
      });
    } finally {
      dispose();
    }
  });

  it("reports missing targets with the original target and resolved folder", async () => {
    const { root, dispose } = fixture();
    try {
      await expect(resolvePlanTarget({ repoRoot: root, target: "missing-plan" })).rejects.toThrow(
        /resume target not found.*missing-plan.*ai_plan/,
      );
    } finally {
      dispose();
    }
  });
});

describe("resume ownership policy", () => {
  it("accepts metadata owned by the invoked tool and rejects owner mismatches", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-owned";
      const folder = createPlanFolder(root, slug);
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "sf_team_task",
        currentTool: "sf_team_task",
        phase: "test",
      }));

      const resolved = await resolvePlanTarget({ repoRoot: root, target: slug });
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_task" }))
        .resolves.toMatchObject({ kind: "metadata", metadata: { ownerTool: "sf_team_task" } });
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_plan" }))
        .rejects.toThrow(/owned by sf_team_task.*sf_team_plan/);
    } finally {
      dispose();
    }
  });

  it("allows legacy five-file folders only for sf_team_implement", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-legacy";
      const folder = createPlanFolder(root, slug);
      for (const name of FIVE_FILE_NAMES) {
        writeFileSync(path.join(folder, name), `# ${name}\n`);
      }
      const resolved = await resolvePlanTarget({ repoRoot: root, target: slug });

      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_implement" }))
        .resolves.toMatchObject({ kind: "legacy-five-file" });
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_auto" }))
        .rejects.toThrow(/Supported metadata-less resume paths are sf_team_implement legacy five-file plans/);
    } finally {
      dispose();
    }
  });

  it("recovers metadata-less auto folders with both plan and implementation checkpoints", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-07-auto-checkpoint-recovery";
      const folder = createPlanFolder(root, slug);
      for (const name of FIVE_FILE_NAMES) {
        writeFileSync(path.join(folder, name), `# ${name}\n`);
      }
      writeCheckpointSteps(root, slug, [
        "spawnText:planner:1",
        "spawnText:reviewer:1",
        "spawnText:developer-M1:1",
        "spawnText:reviewer-M1:1",
      ]);
      const resolved = await resolvePlanTarget({ repoRoot: root, target: slug });

      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_auto" }))
        .resolves.toMatchObject({ kind: "auto-checkpoint-recovery" });
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_task" }))
        .rejects.toThrow(/sf_team_task cannot verify resume ownership/);
    } finally {
      dispose();
    }
  });

  it("rejects metadata-less auto folders with only plan checkpoints", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-07-auto-plan-only";
      const folder = createPlanFolder(root, slug);
      for (const name of FIVE_FILE_NAMES) {
        writeFileSync(path.join(folder, name), `# ${name}\n`);
      }
      writeCheckpointSteps(root, slug, [
        "spawnText:planner:1",
        "spawnText:reviewer:1",
      ]);
      const resolved = await resolvePlanTarget({ repoRoot: root, target: slug });

      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "sf_team_auto" }))
        .rejects.toThrow(/sf_team_auto folders with both plan and implementation checkpoints/);
    } finally {
      dispose();
    }
  });
});
