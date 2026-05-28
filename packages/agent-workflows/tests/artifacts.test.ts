import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINTS_FILE,
  EXECUTION_STRATEGY_FILE,
  FIVE_FILE_NAMES,
  PLAN_FOLDER_ROOT,
  TASK_FILE_NAME,
  VERIFICATION_CACHE_FILE,
  WORKFLOW_FOLDER_NAME,
  atomicWriteFile,
  followupOverlayName,
  planFolderPath,
  workflowArtifactPath,
  workflowCheckpointsPath,
  workflowFolderPath,
  workflowMetadataPath,
  workflowVerificationCachePath,
  writeJsonAtomic,
} from "../src";

function tmp(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workflows-artifacts-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("workflow artifact paths", () => {
  it("builds canonical plan and workflow metadata paths", () => {
    const root = "/repo";
    const slug = "2026-05-06-example";

    expect(PLAN_FOLDER_ROOT).toBe("ai_plan");
    expect(WORKFLOW_FOLDER_NAME).toBe(".sf-workflow");
    expect(CHECKPOINTS_FILE).toBe("checkpoints.json");
    expect(VERIFICATION_CACHE_FILE).toBe("verification-cache.json");
    expect(FIVE_FILE_NAMES).toEqual([
      "original-plan.md",
      "milestone-plan.md",
      "story-tracker.md",
      "continuation-runbook.md",
      "final-transcript.md",
    ]);
    expect(EXECUTION_STRATEGY_FILE).toBe("execution-strategy.json");
    expect(TASK_FILE_NAME).toBe("task-plan.md");
    expect(planFolderPath(root, slug)).toBe(path.join(root, "ai_plan", slug));
    expect(workflowFolderPath(root, slug)).toBe(path.join(root, "ai_plan", slug, ".sf-workflow"));
    expect(workflowMetadataPath(root, slug)).toBe(path.join(root, "ai_plan", slug, ".sf-workflow", "workflow.json"));
    expect(workflowCheckpointsPath(root, slug)).toBe(path.join(root, "ai_plan", slug, ".sf-workflow", "checkpoints.json"));
    expect(workflowVerificationCachePath(root, slug)).toBe(
      path.join(root, "ai_plan", slug, ".sf-workflow", "verification-cache.json"),
    );
    expect(workflowArtifactPath(root, slug, "planner/draft.md")).toBe(
      path.join(root, "ai_plan", slug, ".sf-workflow", "artifacts", "planner", "draft.md"),
    );
  });

  it("formats followup overlay names with the UTC date", () => {
    expect(followupOverlayName(new Date("2026-05-15T23:30:00.000Z"), "fix-edge-case")).toBe(
      "followup-2026-05-15-fix-edge-case.md",
    );
  });
});

describe("atomic artifact writes", () => {
  it("writes file content without leaving the temporary sibling behind", async () => {
    const { root, dispose } = tmp();
    try {
      const target = path.join(root, "nested", "artifact.md");
      await atomicWriteFile(target, "# artifact");

      expect(readFileSync(target, "utf8")).toBe("# artifact");
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      dispose();
    }
  });

  it("writes pretty JSON atomically", async () => {
    const { root, dispose } = tmp();
    try {
      const target = path.join(root, "workflow.json");
      await writeJsonAtomic(target, { schemaVersion: 1, slug: "abc" });

      expect(readFileSync(target, "utf8")).toBe('{\n  "schemaVersion": 1,\n  "slug": "abc"\n}\n');
    } finally {
      dispose();
    }
  });
});
