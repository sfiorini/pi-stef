/**
 * Live failure 2026-05-08: a successful end-to-end `sf_team_auto` run
 * returned `sf_team_auto: plan 1 rounds; 5 milestone(s); performance=...`
 * and the calling LLM (Cursor) misread "5 milestone(s)" as "5 still
 * pending" — then issued follow-up `sf_team_implement` calls that
 * the M1/M2 ownership-mismatch guard correctly rejected.
 *
 * Fix: prefix the result text with `SUCCESS` / `PARTIAL` / `NO-OP`
 * and surface plan-status counts so the calling LLM cannot
 * misinterpret the outcome.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import sfTeamExtension from "../extensions/sf-team";
import { planFolderPath } from "../src/plan/paths";
import { emptyUsageTotal, type CostSummary, type CostUsageTotal } from "../src/orchestrator/cost";
import * as autoModule from "../src/tools/auto";

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
}

class FakePi {
  tools: RegisteredTool[] = [];
  registerTool(tool: RegisteredTool): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

function loadAutoTool(): RegisteredTool {
  const pi = new FakePi();
  sfTeamExtension(pi as never);
  const auto = pi.tools.find((t) => t.name === "sf_team_auto")!;
  expect(auto, "sf_team_auto must be registered").toBeDefined();
  return auto;
}

function seedPlanFolder(
  root: string,
  slug: string,
  trackerBody: string,
): void {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Plan\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(path.join(folder, "story-tracker.md"), trackerBody);
}

function trackerAllApproved(): string {
  return [
    "### M1: One",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-101 | one | completed | abc |",
    "",
    "**Approval Status:** approved (abc)",
    "",
    "### M2: Two",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-201 | two | completed | def |",
    "",
    "**Approval Status:** approved (def)",
    "",
  ].join("\n");
}

function trackerMixed(): string {
  return [
    "### M1: One",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-101 | one | completed | abc |",
    "",
    "**Approval Status:** approved (abc)",
    "",
    "### M2: Two",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-201 | two | pending | |",
    "",
    "**Approval Status:** pending",
    "",
    "### M3: Three",
    "",
    "| Story | Description | Status | Notes |",
    "|-------|-------------|--------|-------|",
    "| S-301 | three | pending | |",
    "",
    "**Approval Status:** pending",
    "",
  ].join("\n");
}

function usage(overrides: Partial<CostUsageTotal> = {}): CostUsageTotal {
  return { ...emptyUsageTotal(), ...overrides };
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

describe("sf_team_auto result text: SUCCESS / PARTIAL / NO-OP prefix", () => {
  it("SUCCESS — fresh run that approves every milestone names the count and the branch and shows 0 pending", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-auto-text-success-"));
    const slug = "demo-success";
    try {
      seedPlanFolder(root, slug, trackerAllApproved());
      const fakeAuto = vi.fn(async () => ({
        slug,
        planRounds: 1,
        implement: {
          slug,
          mode: "all-milestones" as const,
          branch: "auto/demo-success",
          milestones: [
            { id: "M1", approved: true, rounds: 1, commitSha: "abc" },
            { id: "M2", approved: true, rounds: 1, commitSha: "def" },
          ],
        },
      }));
      const factorySpy = vi.spyOn(autoModule, "createSfTeamAuto").mockReturnValue(fakeAuto as never);
      try {
        const tool = loadAutoTool();
        const prevCwd = process.cwd();
        process.chdir(root);
        try {
          const response = await tool.execute("call-1", { title: "demo" }, undefined, undefined, { hasUI: false } as never);
          const text = response.content[0].text;
          expect(text).toContain("sf_team_auto: SUCCESS");
          expect(text).toContain("plan reviewed in 1 round(s)");
          expect(text).toContain("2/2 milestone(s) approved this run on branch auto/demo-success");
          expect(text).toContain("Plan status: 2/2 milestone(s) approved; 0 pending.");
          // SUCCESS branch must NOT include a "Next:" hint — there's nothing pending.
          expect(text).not.toMatch(/Next:/);
        } finally {
          process.chdir(prevCwd);
        }
      } finally {
        factorySpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PARTIAL — run approves some but plan still has pending milestones, includes a Next: hint with the pending milestone id and a `sf_team_auto_resume` invocation example", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-auto-text-partial-"));
    const slug = "demo-partial";
    try {
      seedPlanFolder(root, slug, trackerMixed());
      const fakeAuto = vi.fn(async () => ({
        slug,
        planRounds: 0,
        implement: {
          slug,
          mode: "all-milestones" as const,
          branch: "auto/demo-partial",
          milestones: [
            { id: "M1", approved: true, rounds: 1, commitSha: "abc" },
          ],
        },
      }));
      const factorySpy = vi.spyOn(autoModule, "createSfTeamAuto").mockReturnValue(fakeAuto as never);
      try {
        const tool = loadAutoTool();
        const prevCwd = process.cwd();
        process.chdir(root);
        try {
          const response = await tool.execute("call-1", { resume: slug }, undefined, undefined, { hasUI: false } as never);
          const text = response.content[0].text;
          expect(text).toContain("sf_team_auto: PARTIAL");
          expect(text).toContain("1/1 milestone(s) approved this run on branch auto/demo-partial");
          expect(text).toContain("Plan status: 1/3 milestone(s) approved; 2 pending (M2, M3).");
          expect(text).toContain("Next: invoke sf_team_auto_resume { resume: 'demo-partial' } to continue with M2.");
        } finally {
          process.chdir(prevCwd);
        }
      } finally {
        factorySpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("NO-OP — resume after completion processes 0 milestones; result text says nothing to do, plan already at N/N", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-auto-text-noop-"));
    const slug = "demo-noop";
    try {
      seedPlanFolder(root, slug, trackerAllApproved());
      const fakeAuto = vi.fn(async () => ({
        slug,
        planRounds: 0,
        implement: {
          slug,
          mode: "all-milestones" as const,
          branch: "auto/demo-noop",
          milestones: [],
        },
      }));
      const factorySpy = vi.spyOn(autoModule, "createSfTeamAuto").mockReturnValue(fakeAuto as never);
      try {
        const tool = loadAutoTool();
        const prevCwd = process.cwd();
        process.chdir(root);
        try {
          const response = await tool.execute("call-1", { resume: slug }, undefined, undefined, { hasUI: false } as never);
          const text = response.content[0].text;
          expect(text).toContain("sf_team_auto: NO-OP");
          expect(text).toContain("nothing to do this run; plan already at 2/2 approved.");
          expect(text).toContain("Plan status: 2/2 milestone(s) approved; 0 pending.");
          // NO-OP branch must NOT include a "Next:" hint — nothing left to do.
          expect(text).not.toMatch(/Next:/);
        } finally {
          process.chdir(prevCwd);
        }
      } finally {
        factorySpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends plan-phase cost when auto has no implement cost summary fallback available", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-auto-text-cost-"));
    const slug = "demo-cost";
    const costSummary = exactCostSummary(1.23);
    try {
      seedPlanFolder(root, slug, trackerAllApproved());
      const fakeAuto = vi.fn(async () => ({
        slug,
        planRounds: 1,
        implement: {
          slug,
          mode: "all-milestones" as const,
          branch: "auto/demo-cost",
          milestones: [
            { id: "M1", approved: true, rounds: 1, commitSha: "abc" },
            { id: "M2", approved: true, rounds: 1, commitSha: "def" },
          ],
        },
        costSummary,
      }));
      const factorySpy = vi.spyOn(autoModule, "createSfTeamAuto").mockReturnValue(fakeAuto as never);
      try {
        const tool = loadAutoTool();
        const prevCwd = process.cwd();
        process.chdir(root);
        try {
          const response = await tool.execute("call-1", { title: "demo" }, undefined, undefined, { hasUI: false } as never);
          expect(response.content[0].text).toContain("Your total cost is $1.23.");
        } finally {
          process.chdir(prevCwd);
        }
      } finally {
        factorySpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
