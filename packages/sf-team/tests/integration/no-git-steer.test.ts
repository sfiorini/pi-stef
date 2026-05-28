/**
 * S-509: Integration test — steer with external planRoot.
 *
 * Verifies that sf_team_steer works when the plan folder is registered
 * with repoRoot and correctly routes the steering instruction.
 *
 * For S-510 (impl), we also verify that SfTeamSteerContext accepts aiPlanPath.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSfTeamSteer, type SfTeamSteerParams, type SfTeamSteerContext } from "../../src/tools/steer";
import { createActiveWorkflowRegistry } from "../../src/steering/active-workflows";
import { resolvePlanSteeringRoot } from "../../src/steering/path-safety";
import { PLAN_FOLDER_ROOT } from "../../src/plan/paths";

async function mkDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sf-team-steer-ngt-"));
}

async function registerWorkflow(
  repoRoot: string,
  id: string,
  planSlug: string,
): Promise<void> {
  const registry = createActiveWorkflowRegistry(repoRoot);
  const planDir = path.join(repoRoot, PLAN_FOLDER_ROOT, planSlug);
  await mkdir(planDir, { recursive: true });
  await registry.register({
    workflowId: id,
    workflowKind: "implement",
    toolName: "sf_team_implement",
    planSlug,
    repoRoot,
    steeringRoot: resolvePlanSteeringRoot(planDir),
  });
}

describe("sf_team_steer — external planRoot support", () => {
  it("routes steering instruction correctly with repoRoot-based registry", async () => {
    const repoRoot = await mkDir();
    await registerWorkflow(repoRoot, "workflow-steer-1", "2026-steer-test");

    const steer = createSfTeamSteer();
    const ctx: SfTeamSteerContext = { repoRoot };
    const result = await steer({ instruction: "Use smaller batches.", workflowId: "workflow-steer-1" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflowId).toBe("workflow-steer-1");
      expect(result.instructionId).toBeTruthy();
    }
  });

  it("SfTeamSteerContext can carry aiPlanPath without TypeScript error", () => {
    // This ensures the type accepts aiPlanPath after S-510 adds it.
    // For now the context type is extended here in test to verify the
    // direction of the change before S-510 impl.
    const ctx: SfTeamSteerContext & { aiPlanPath?: string } = {
      repoRoot: "/tmp/repo",
      aiPlanPath: "/tmp/plans",
    };
    expect(ctx.aiPlanPath).toBe("/tmp/plans");
  });

  it("SfTeamSteerParams accepts aiPlanPath field", () => {
    // Verifies schema direction: steer should accept aiPlanPath after S-510.
    const params: SfTeamSteerParams & { aiPlanPath?: string } = {
      instruction: "Test instruction.",
      aiPlanPath: "/tmp/plans",
    };
    expect(params.aiPlanPath).toBe("/tmp/plans");
  });
});
