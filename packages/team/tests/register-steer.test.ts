import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createActiveWorkflowRegistry } from "../src/steering/active-workflows";
import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { registerSfTeam, TEAM_STEER_TOOL_NAME, TEAM_TOOL_NAMES } from "../src/register";

class FakePi {
  tools: Array<{ name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }> = [];
  commands: Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }> = [];
  sent: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];

  registerTool(tool: { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }

  registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void {
    this.commands.push({ name, handler: options.handler });
  }

  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
    this.sent.push({ content, options });
  }
}

async function mkRepo(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sf-team-register-steer-"));
}

async function registerWorkflow(repoRoot: string, id: string, planSlug: string): Promise<void> {
  // Production code registers under planRoot (defaults to repoRoot/ai_plan).
  // Mirror that here so the slash-command steer test resolves the same registry path.
  const planRootDir = path.join(repoRoot, "ai_plan");
  const registry = createActiveWorkflowRegistry(planRootDir);
  const planFolder = path.join(planRootDir, planSlug);
  await mkdir(planFolder, { recursive: true });
  await registry.register({
    workflowId: id,
    workflowKind: "implement",
    toolName: "sf_team_implement",
    planSlug,
    repoRoot,
    steeringRoot: resolvePlanSteeringRoot(planFolder),
  });
}

async function inboxEntries(repoRoot: string, planSlug: string): Promise<Array<{ text: string; workflowId: string }>> {
  const raw = await readFile(path.join(repoRoot, "ai_plan", planSlug, ".pi", "sf", "agent-workflows", "steering", "inbox.jsonl"), "utf8");
  return raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { text: string; workflowId: string });
}

describe("sf_team_steer registration", () => {
  it("registers sf_team_steer once without an unintended _resume variant", () => {
    const pi = new FakePi();
    registerSfTeam(pi as never);

    expect(pi.tools.map((tool) => tool.name)).toEqual([...TEAM_TOOL_NAMES]);
    expect(pi.tools.map((tool) => tool.name)).not.toContain("sf_team_steer_resume");
  });

  it("registers a slash command that queues busy-session input directly", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const pi = new FakePi();
    registerSfTeam(pi as never);
    const command = pi.commands.find((entry) => entry.name === "sf-team-steer");
    const notify = vi.fn();
    const originalCwd = process.cwd();

    expect(command).toBeDefined();
    try {
      process.chdir(repoRoot);
      await command!.handler("Were you able to use the figma tool to fetch the figma link?", {
        isIdle: () => false,
        ui: { notify },
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(pi.sent).toEqual([]);
    expect(await inboxEntries(repoRoot, "plan-a")).toMatchObject([
      { text: "Were you able to use the figma tool to fetch the figma link?", workflowId: "workflow-a" },
    ]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("queued instruction"), "info");
  });

  it("routes to external aiPlanPath registry when aiPlanPath= is supplied", async () => {
    const repoRoot = await mkRepo();
    const externalPlanRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-register-steer-ext-"));
    // Register the workflow under a DIFFERENT root (not repoRoot)
    const registry = createActiveWorkflowRegistry(externalPlanRoot);
    const planRoot = path.join(externalPlanRoot, "plan-b");
    await mkdir(planRoot, { recursive: true });
    await registry.register({
      workflowId: "workflow-ext",
      workflowKind: "implement",
      toolName: "sf_team_implement",
      planSlug: "plan-b",
      repoRoot: externalPlanRoot,
      steeringRoot: resolvePlanSteeringRoot(planRoot),
    });

    const pi = new FakePi();
    registerSfTeam(pi as never);
    const command = pi.commands.find((entry) => entry.name === "sf-team-steer");
    const notify = vi.fn();
    const originalCwd = process.cwd();

    expect(command).toBeDefined();
    try {
      process.chdir(repoRoot);
      await command!.handler(`aiPlanPath=${externalPlanRoot} planSlug=plan-b instruction="update the approach"`, {
        isIdle: () => false,
        ui: { notify },
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(pi.sent).toEqual([]);
    const entries = await readFile(
      path.join(externalPlanRoot, "plan-b", ".pi", "sf", "agent-workflows", "steering", "inbox.jsonl"),
      "utf8",
    );
    const parsed = entries.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { text: string; workflowId: string });
    expect(parsed).toMatchObject([{ text: "update the approach", workflowId: "workflow-ext" }]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("queued instruction"), "info");
  });

  it("preserves unknown key-value prose in slash-command instruction text", async () => {
    const repoRoot = await mkRepo();
    await registerWorkflow(repoRoot, "workflow-a", "plan-a");
    const pi = new FakePi();
    registerSfTeam(pi as never);
    const command = pi.commands.find((entry) => entry.name === "sf-team-steer");
    const notify = vi.fn();
    const originalCwd = process.cwd();

    expect(command).toBeDefined();
    try {
      process.chdir(repoRoot);
      await command!.handler("use=mocks because backend is not ready", {
        isIdle: () => false,
        ui: { notify },
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(await inboxEntries(repoRoot, "plan-a")).toMatchObject([
      { text: "use=mocks because backend is not ready", workflowId: "workflow-a" },
    ]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("queued instruction"), "info");
  });

  it("keeps an empty steering slash command as an agent prompt for missing args", async () => {
    const pi = new FakePi();
    registerSfTeam(pi as never);
    const command = pi.commands.find((entry) => entry.name === "sf-team-steer");

    expect(command).toBeDefined();
    await command!.handler("", { isIdle: () => true });

    expect(pi.sent).toEqual([
      {
        content: "Invoke the sf_team_steer tool. Ask me first for the instruction and, if needed, the workflowId or planSlug.",
      },
    ]);
  });
});
