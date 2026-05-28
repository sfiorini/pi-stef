/**
 * S-511b: Integration test — slug-only resume via global plan-index.
 *
 * When a workflow was registered in the global plan-index (~/.fh-team/plan-index.json),
 * a slug-only resume from ANY cwd must find it via the index cascade.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  analyzeResumeTarget,
  upsertEntry,
  createWorkflowMetadata,
  writeWorkflowMetadata,
} from "@pi-stef/agent-workflows";

describe("resume-via-global-index — slug-only resume from unrelated cwd finds plan via index", () => {
  it("falls through to global plan-index when no explicit candidatePlanRoots match", async () => {
    const planRoot = mkdtempSync(path.join(tmpdir(), "ct-idx-planroot-"));
    const otherCwd = mkdtempSync(path.join(tmpdir(), "ct-idx-other-cwd-"));
    const slug = `2026-05-27-global-index-test-${Date.now()}`;
    const planFolder = path.join(planRoot, slug);
    const fhWorkflowDir = path.join(planFolder, ".fh-workflow");
    mkdirSync(fhWorkflowDir, { recursive: true });

    try {
      // Write workflow.json so the index can verify it still exists
      const metadata = createWorkflowMetadata({
        slug,
        folderPath: planFolder,
        ownerTool: "fh_team_task",
        currentTool: "fh_team_task",
        phase: "implementation",
        planRootPath: planRoot,
        gitMode: "off",
        tddMode: "auto",
      });
      await writeWorkflowMetadata(otherCwd, metadata, planRoot);

      // Register in the global index
      upsertEntry(slug, { planRoot, tool: "fh_team_task" });

      // Resume from otherCwd with empty candidatePlanRoots to fall through to index
      const analysis = await analyzeResumeTarget({
        repoRoot: otherCwd,
        target: slug,
        invokedTool: "fh_team_task",
        candidatePlanRoots: [],
      });

      expect(analysis).toBeDefined();
      expect(analysis!.target.slug).toBe(slug);
      expect(analysis!.metadata?.gitMode).toBe("off");
    } finally {
      rmSync(planRoot, { recursive: true, force: true });
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});
