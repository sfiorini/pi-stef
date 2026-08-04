import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertResumeOwnership,
  createWorkflowMetadata,
  resolvePlanTarget,
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
  // Write workflow.json so resolvePlanTarget can find it via candidatePlanRoots
  const wfDir = path.join(folder, ".pi", "sf", "agent-workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(path.join(wfDir, "workflow.json"), JSON.stringify({
    schemaVersion: 1,
    slug,
    folderPath: folder,
    ownerTool: "test_plan",
    currentTool: "test_plan",
    createdAt: "2026-05-07T12:00:00.000Z",
    updatedAt: "2026-05-07T12:00:00.000Z",
    status: "running",
    phase: "planning",
    checkpoints: {},
    commitIntents: {},
  }));
  return folder;
}

describe("resume target resolution", () => {
  it("resolves slug, absolute path, and relative path targets to the same plan folder", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-resume-demo";
      const folder = createPlanFolder(root, slug);

      await expect(resolvePlanTarget({ repoRoot: root, target: slug, candidatePlanRoots: [path.join(root, "ai_plan")] })).resolves.toMatchObject({
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
      await expect(resolvePlanTarget({ repoRoot: root, target: "missing-plan", candidatePlanRoots: [path.join(root, "ai_plan")] })).rejects.toThrow(
        /resume target not found.*missing-plan/,
      );
    } finally {
      dispose();
    }
  });
});

describe("resume ownership policy", () => {
  it("returns metadata when workflow.json exists", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-owned";
      const folder = createPlanFolder(root, slug);
      await writeWorkflowMetadata(root, createWorkflowMetadata({
        slug,
        folderPath: folder,
        ownerTool: "test_task",
        currentTool: "test_task",
        phase: "test",
      }));

      const resolved = await resolvePlanTarget({ repoRoot: root, target: slug, candidatePlanRoots: [path.join(root, "ai_plan")] });
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "test_task" }))
        .resolves.toMatchObject({ kind: "metadata", metadata: { ownerTool: "test_task" } });
    } finally {
      dispose();
    }
  });

  it("throws when workflow.json is missing", async () => {
    const { root, dispose } = fixture();
    try {
      const slug = "2026-05-06-no-metadata";
      const folder = path.join(root, "ai_plan", slug);
      mkdirSync(folder, { recursive: true });
      // Don't write workflow.json

      const resolved = { slug, folderPath: folder, target: slug, targetKind: "slug" as const };
      await expect(assertResumeOwnership({ repoRoot: root, target: resolved, invokedTool: "test_implement" }))
        .rejects.toThrow(/workflow metadata not found/);
    } finally {
      dispose();
    }
  });
});
