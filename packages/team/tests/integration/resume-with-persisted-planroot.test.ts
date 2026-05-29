/**
 * S-511a: Integration test — resume using persisted planRoot from workflow.json.
 *
 * When a workflow was originally run with gitMode='off' and an external planRoot,
 * a resume from a different cwd must:
 *   - Find the plan folder via candidatePlanRoots (planRoot cascade)
 *   - Use the persisted gitMode='off' from workflow.json metadata
 *   - NOT commit (commitSha undefined)
 *   - NOT generate a PR description (prDescriptionPath undefined)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { analyzeResumeTarget } from "@pi-stef/agent-workflows";
import {
  createWorkflowMetadata,
  writeWorkflowMetadata,
} from "@pi-stef/agent-workflows";

describe("resume-with-persisted-planroot — slug-only resume finds workflow and rehydrates gitMode", () => {
  it("analyzeResumeTarget with candidatePlanRoots finds workflow.json and returns persisted gitMode='off'", async () => {
    const planRoot = mkdtempSync(path.join(tmpdir(), "ct-planroot-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-repo-"));
    const slug = "2026-05-27-test-persist-planroot";
    const planFolder = path.join(planRoot, slug);
    const fhWorkflowDir = path.join(planFolder, ".pi", "sf", "agent-workflows");
    mkdirSync(fhWorkflowDir, { recursive: true });

    try {
      // Simulate what the orchestrator writes after starting a workflow
      const metadata = createWorkflowMetadata({
        slug,
        folderPath: planFolder,
        ownerTool: "sf_team_task",
        currentTool: "sf_team_task",
        phase: "implementation",
        planRootPath: planRoot,
        gitMode: "off",
        tddMode: "auto",
      });
      await writeWorkflowMetadata(repoRoot, metadata, planRoot);

      // Resume from a different repoRoot using candidatePlanRoots pointing to planRoot
      const analysis = await analyzeResumeTarget({
        repoRoot: mkdtempSync(path.join(tmpdir(), "ct-other-cwd-")),
        target: slug,
        invokedTool: "sf_team_task",
        candidatePlanRoots: [planRoot],
      });

      expect(analysis).toBeDefined();
      expect(analysis!.target.slug).toBe(slug);
      // The metadata should have gitMode='off'
      expect(analysis!.metadata?.gitMode).toBe("off");
      expect(analysis!.metadata?.planRootPath).toBe(planRoot);
    } finally {
      rmSync(planRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("candidatePlanRoots takes precedence over default cwd-based search", async () => {
    const planRoot = mkdtempSync(path.join(tmpdir(), "ct-planroot-"));
    const cwdRoot = mkdtempSync(path.join(tmpdir(), "ct-cwd-"));
    const slug = "2026-05-27-test-cascade-order";

    // Create plan in planRoot only (NOT in cwdRoot/ai_plan)
    const planFolder = path.join(planRoot, slug);
    const fhWorkflowDir = path.join(planFolder, ".pi", "sf", "agent-workflows");
    mkdirSync(fhWorkflowDir, { recursive: true });

    try {
      const metadata = createWorkflowMetadata({
        slug,
        folderPath: planFolder,
        ownerTool: "sf_team_implement",
        currentTool: "sf_team_implement",
        phase: "implementation",
        planRootPath: planRoot,
        gitMode: "off",
        tddMode: "off",
      });
      await writeWorkflowMetadata(cwdRoot, metadata, planRoot);

      const analysis = await analyzeResumeTarget({
        repoRoot: cwdRoot,
        target: slug,
        invokedTool: "sf_team_implement",
        candidatePlanRoots: [planRoot],
      });

      expect(analysis).toBeDefined();
      expect(analysis!.metadata?.gitMode).toBe("off");
      expect(analysis!.metadata?.tddMode).toBe("off");
    } finally {
      rmSync(planRoot, { recursive: true, force: true });
      rmSync(cwdRoot, { recursive: true, force: true });
    }
  });
});
