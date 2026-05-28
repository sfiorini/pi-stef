import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import sfTeamExtension from "../extensions/sf-team";
import { planFolderPath } from "../src/plan/paths";
import { emptyUsageTotal, type CostSummary, type CostUsageTotal } from "../src/orchestrator/cost";
import * as autoModule from "../src/tools/auto";
import * as followupModule from "../src/tools/followup";
import * as implementModule from "../src/tools/implement";
import * as planModule from "../src/tools/plan";
import * as taskModule from "../src/tools/task";

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

class FakePi {
  tools: RegisteredTool[] = [];
  registerTool(tool: RegisteredTool): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

function loadTool(name: string): RegisteredTool {
  const pi = new FakePi();
  sfTeamExtension(pi as never);
  const tool = pi.tools.find((t) => t.name === name);
  expect(tool, `${name} must be registered`).toBeDefined();
  return tool!;
}

function usage(overrides: Partial<CostUsageTotal> = {}): CostUsageTotal {
  return {
    ...emptyUsageTotal(),
    ...overrides,
  };
}

function exactCostSummary(cost: number): CostSummary {
  const total = usage({ costTotal: cost, knownCostCount: 1 });
  return {
    prior: emptyUsageTotal(),
    settled: total,
    current: total,
    total,
    priorRunCount: 0,
    settledRunCount: 1,
    inFlightRunCount: 0,
  };
}

function seedPlanFolder(root: string, slug: string): void {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Plan\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(path.join(folder, "story-tracker.md"), [
    "### M1: One",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-101 | one | completed | abc |",
    "",
    "**Approval Status:** approved (abc)",
    "",
  ].join("\n"));
}

describe("registered sf-team cost summaries", () => {
  it("appends final cost sentence to sf_team_plan output and preserves details.costSummary", async () => {
    const costSummary = exactCostSummary(1.23);
    const fakePlan = vi.fn(async () => ({
      slug: "plan-cost",
      approved: true,
      rounds: 2,
      finalPlan: "# Plan",
      folderPath: "/tmp/plan-cost",
      performanceReportPath: "/tmp/perf.md",
      agentSettings: {},
      researcherDecision: { policy: "auto", action: "skipped", reason: "test", externalRefs: 0, signals: [] },
      revisionMetrics: [],
      costSummary,
    }));
    const spy = vi.spyOn(planModule, "createSfTeamPlan").mockReturnValue(fakePlan as never);
    try {
      const tool = loadTool("sf_team_plan");
      const response = await tool.execute("call-1", { title: "x" }, undefined, undefined, { hasUI: false } as never);
      expect(response.content[0].text).toContain("Your total cost is $1.23.");
      expect(response.details.costSummary).toBe(costSummary);
    } finally {
      spy.mockRestore();
    }
  });

  it("appends final cost sentence to implement, task, followup, and auto outputs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-cost-registered-"));
    const costSummary = exactCostSummary(10.58);
    try {
      seedPlanFolder(root, "impl-cost");
      const fakeImplement = vi.fn(async () => ({
        slug: "impl-cost",
        mode: "all-milestones",
        branch: "implement/impl-cost",
        milestones: [{ id: "M1", approved: true, rounds: 1, commitSha: "abc" }],
        performanceReportPath: "/tmp/impl-perf.md",
        costSummary,
      }));
      const fakeTask = vi.fn(async () => ({
        slug: "task-cost",
        approved: true,
        rounds: { plan: 1, impl: 1 },
        commitSha: "abc",
        performanceReportPath: "/tmp/task-perf.md",
        pushed: false,
        revisionMetrics: [],
        costSummary,
      }));
      const fakeAuto = vi.fn(async () => ({
        slug: "impl-cost",
        planRounds: 1,
        implement: await fakeImplement(),
        agentSettings: {},
        researcherDecision: { policy: "auto", action: "skipped", reason: "test", externalRefs: 0, signals: [] },
        performanceReportPaths: ["/tmp/plan-perf.md", "/tmp/impl-perf.md"],
        costSummary,
      }));
      const implSpy = vi.spyOn(implementModule, "createSfTeamImplement").mockReturnValue(fakeImplement as never);
      const taskSpy = vi.spyOn(taskModule, "createSfTeamTask").mockReturnValue(fakeTask as never);
      const followupSpy = vi.spyOn(followupModule, "createSfTeamFollowup").mockReturnValue(fakeTask as never);
      const autoSpy = vi.spyOn(autoModule, "createSfTeamAuto").mockReturnValue(fakeAuto as never);
      const prevCwd = process.cwd();
      process.chdir(root);
      try {
        for (const name of ["sf_team_implement", "sf_team_task", "sf_team_followup", "sf_team_auto"]) {
          const tool = loadTool(name);
          const params = name === "sf_team_implement" ? { slug: "impl-cost" } : { title: "x" };
          const response = await tool.execute("call-1", params, undefined, undefined, { hasUI: false } as never);
          expect(response.content[0].text, name).toContain("Your total cost is $10.58.");
          expect(response.details.costSummary, name).toBe(costSummary);
        }
      } finally {
        process.chdir(prevCwd);
        implSpy.mockRestore();
        taskSpy.mockRestore();
        followupSpy.mockRestore();
        autoSpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
