import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createActiveWorkflowRegistry } from "../src/steering/active-workflows";
import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { createSfTeamSteer } from "../src/tools/steer";

async function mkRepo(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sf-team-steer-"));
}

async function registerWorkflow(repoRoot: string, id: string, planSlug: string): Promise<void> {
  const registry = createActiveWorkflowRegistry(repoRoot);
  const planRoot = path.join(repoRoot, "ai_plan", planSlug);
  await mkdir(planRoot, { recursive: true });
  await registry.register({
    workflowId: id,
    workflowKind: "implement",
    toolName: "sf_team_implement",
    planSlug,
    repoRoot,
    steeringRoot: resolvePlanSteeringRoot(planRoot),
  });
}

async function inboxEntries(repoRoot: string, planSlug: string): Promise<Array<{ text: string; workflowId: string }>> {
  const raw = await readFile(path.join(repoRoot, "ai_plan", planSlug, ".pi", "sf", "agent-workflows", "steering", "inbox.jsonl"), "utf8");
  return raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { text: string; workflowId: string });
}

describe("sf_team_steer tool", () => {
  it("targets an explicit workflow id and persists the instruction", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const steer = createSfTeamSteer();

    const result = await steer({ workflowId: "workflow-a", instruction: "Prefer smaller story batches." }, { repoRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.workflowId).toBe("workflow-a");
    expect(result.instructionId).toBeTruthy();
    expect(await inboxEntries(repoRoot, "plan-a")).toMatchObject([
      { text: "Prefer smaller story batches.", workflowId: "workflow-a" },
    ]);
  });

  it("targets an explicit plan slug", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const steer = createSfTeamSteer();

    const result = await steer({ planSlug: "plan-a", instruction: "Adjust future prompts." }, { repoRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.workflowId).toBe("workflow-a");
  });

  it("targets the single active workflow when no explicit target is provided", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const steer = createSfTeamSteer();

    const result = await steer({ instruction: "Use the existing helper." }, { repoRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.workflowId).toBe("workflow-a");
  });

  it("returns candidates for ambiguous active workflows", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    await registerWorkflow(repoRoot, "workflow-b", "plan-b");
    const steer = createSfTeamSteer();

    const result = await steer({ instruction: "Pause after this story." }, { repoRoot });

    expect(result).toMatchObject({
      ok: false,
      reason: "ambiguous-target",
      candidates: [
        { workflowId: "workflow-a", planSlug: "plan-a" },
        { workflowId: "workflow-b", planSlug: "plan-b" },
      ],
    });
  });

  it("returns no-active-workflow when nothing is registered", async () => {
    const repoRoot = await mkRepo();
    const steer = createSfTeamSteer();

    await expect(steer({ instruction: "Please steer." }, { repoRoot })).resolves.toMatchObject({
      ok: false,
      reason: "no-active-workflow",
    });
  });

  it("rejects oversized instructions without appending", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const steer = createSfTeamSteer();

    await expect(
      steer({ workflowId: "workflow-a", instruction: "too long" }, { repoRoot, config: { maxInstructionChars: 3 } }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid-instruction",
    });
  });
});
