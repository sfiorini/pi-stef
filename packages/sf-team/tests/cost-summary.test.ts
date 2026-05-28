import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { reportsFolderPath } from "@pi-stef/agent-workflows";

import {
  addUsage,
  composeCostSummary,
  emptyUsageTotal,
  formatCost,
  formatFinalCostSentence,
  readHistoricalCostSummary,
  usageFromAgentUsage,
  type CostUsageTotal,
} from "../src/orchestrator/cost";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-cost-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function usage(overrides: Partial<CostUsageTotal> = {}): CostUsageTotal {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    knownCostCount: 0,
    unknownCostCount: 0,
    ...overrides,
  };
}

describe("cost summary helpers", () => {
  it("adds token totals and preserves known versus unknown cost provenance", () => {
    const total = addUsage(
      usage({ input: 100, output: 20, totalTokens: 120, costTotal: 0.25, knownCostCount: 1 }),
      usage({ input: 50, cacheRead: 10, totalTokens: 60, unknownCostCount: 1 }),
    );

    expect(total).toEqual({
      input: 150,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 180,
      costTotal: 0.25,
      knownCostCount: 1,
      unknownCostCount: 1,
    });
  });

  it("does not turn unavailable cost into zero", () => {
    expect(usageFromAgentUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      knownCostCount: 0,
      unknownCostCount: 1,
    });
  });

  it("formats zero, sub-cent, and cent-plus values", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(10.58)).toBe("$10.58");
    expect(formatCost(undefined)).toBe("");
  });

  it("composes prior, settled, and in-flight usage", () => {
    const settled = new Map([
      ["planner#1", usage({ totalTokens: 100, costTotal: 0.25, knownCostCount: 1 })],
      ["reviewer#1", usage({ totalTokens: 20, unknownCostCount: 1 })],
    ]);
    const inFlight = new Map([
      ["developer#2", usage({ totalTokens: 80, costTotal: 0.75, knownCostCount: 1 })],
    ]);

    const summary = composeCostSummary(
      { usage: usage({ totalTokens: 10, costTotal: 1, knownCostCount: 1 }), reportCount: 1 },
      settled,
      inFlight,
    );

    expect(summary.priorRunCount).toBe(1);
    expect(summary.settledRunCount).toBe(2);
    expect(summary.inFlightRunCount).toBe(1);
    expect(summary.current.costTotal).toBe(1);
    expect(summary.total.costTotal).toBe(2);
    expect(summary.total.unknownCostCount).toBe(1);
  });

  it("formats final sentences only when at least one cost is known", () => {
    expect(formatFinalCostSentence(composeCostSummary(
      { usage: emptyUsageTotal(), reportCount: 0 },
      new Map([["a", usage({ costTotal: 10.58, knownCostCount: 1 })]]),
      new Map(),
    ))).toBe("Your total cost is $10.58.");

    expect(formatFinalCostSentence(composeCostSummary(
      { usage: emptyUsageTotal(), reportCount: 0 },
      new Map([["a", usage({ costTotal: 10.58, knownCostCount: 1, unknownCostCount: 1 })]]),
      new Map(),
    ))).toBe("Your total cost is at least $10.58 (some agents did not report cost).");

    expect(formatFinalCostSentence(composeCostSummary(
      { usage: emptyUsageTotal(), reportCount: 0 },
      new Map([["a", usage({ unknownCostCount: 1 })]]),
      new Map(),
    ))).toBeUndefined();
  });
});

describe("historical cost parsing", () => {
  it("prefers JSON sidecars and scopes by owner metadata", async () => {
    const { root, dispose } = makeRepo();
    try {
      const folder = reportsFolderPath(root, "slug-a");
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "performance-2026-json.md"), "# ignored markdown\n");
      writeFileSync(path.join(folder, "performance-2026-json.json"), JSON.stringify({
        schemaVersion: 1,
        slug: "slug-a",
        toolName: "sf_team_plan",
        ownerTool: "sf_team_auto",
        status: "completed",
        startedAt: "2026-05-12T00:00:00.000Z",
        finishedAt: "2026-05-12T00:00:01.000Z",
        runUsage: usage({ totalTokens: 100, costTotal: 1.25, knownCostCount: 1 }),
        costSummary: {
          prior: emptyUsageTotal(),
          settled: usage({ totalTokens: 100, costTotal: 1.25, knownCostCount: 1 }),
          current: usage({ totalTokens: 100, costTotal: 1.25, knownCostCount: 1 }),
          total: usage({ totalTokens: 100, costTotal: 1.25, knownCostCount: 1 }),
          priorRunCount: 0,
          settledRunCount: 1,
          inFlightRunCount: 0,
        },
      }));
      writeFileSync(path.join(folder, "performance-2026-other.json"), JSON.stringify({
        schemaVersion: 1,
        slug: "slug-a",
        toolName: "sf_team_plan",
        ownerTool: "sf_team_plan",
        status: "completed",
        startedAt: "2026-05-12T00:00:00.000Z",
        finishedAt: "2026-05-12T00:00:01.000Z",
        runUsage: usage({ totalTokens: 100, costTotal: 9, knownCostCount: 1 }),
      }));

      const result = await readHistoricalCostSummary(root, "slug-a", {
        logicalToolName: "sf_team_plan",
        ownerTool: "sf_team_auto",
      });

      expect(result.reportCount).toBe(1);
      expect(result.usage.costTotal).toBe(1.25);
    } finally {
      dispose();
    }
  });

  it("falls back to legacy markdown and marks recovered cost as partial", async () => {
    const { root, dispose } = makeRepo();
    try {
      const folder = reportsFolderPath(root, "slug-b");
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "performance-2026-md.md"), [
        "# sf-team performance - sf_team_implement",
        "",
        "## Token Usage",
        "",
        "| runs with usage | input | output | cache read | cache write | total tokens | cost |",
        "| -: | -: | -: | -: | -: | -: | -: |",
        "| 1 | 10 | 20 | 0 | 0 | 30 | $0.0004 |",
      ].join("\n"));

      const result = await readHistoricalCostSummary(root, "slug-b", {
        logicalToolName: "sf_team_implement",
      });

      expect(result.reportCount).toBe(1);
      expect(result.usage.costTotal).toBe(0.0004);
      expect(result.usage.knownCostCount).toBe(1);
      expect(result.usage.unknownCostCount).toBe(1);
    } finally {
      dispose();
    }
  });

  it("includes legacy plan and implement reports only for auto fallback", async () => {
    const { root, dispose } = makeRepo();
    try {
      const folder = reportsFolderPath(root, "slug-c");
      mkdirSync(folder, { recursive: true });
      for (const [tool, cost] of [["sf_team_plan", "$1.00"], ["sf_team_implement", "$2.00"], ["sf_team_task", "$3.00"]] as const) {
        writeFileSync(path.join(folder, `performance-${tool}.md`), [
          `# sf-team performance — ${tool}`,
          "",
          "## Token Usage",
          "",
          "| runs with usage | input | output | cache read | cache write | total tokens | cost |",
          "| -: | -: | -: | -: | -: | -: | -: |",
          `| 1 | 0 | 0 | 0 | 0 | 0 | ${cost} |`,
        ].join("\n"));
      }

      const auto = await readHistoricalCostSummary(root, "slug-c", {
        logicalToolName: "sf_team_auto",
        ownerTool: "sf_team_auto",
        includeLegacyAutoReports: true,
      });
      const implement = await readHistoricalCostSummary(root, "slug-c", {
        logicalToolName: "sf_team_implement",
      });

      expect(auto.reportCount).toBe(2);
      expect(auto.usage.costTotal).toBe(3);
      expect(implement.reportCount).toBe(1);
      expect(implement.usage.costTotal).toBe(2);
    } finally {
      dispose();
    }
  });

  it("falls back to markdown when a JSON sidecar is malformed", async () => {
    const { root, dispose } = makeRepo();
    try {
      const folder = reportsFolderPath(root, "slug-d");
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "performance-bad.json"), "{not json");
      writeFileSync(path.join(folder, "performance-bad.md"), [
        "# sf-team performance — sf_team_task",
        "",
        "- **owner tool**: sf_team_task",
        "",
        "## Token Usage",
        "",
        "| runs with usage | input | output | cache read | cache write | total tokens | cost |",
        "| -: | -: | -: | -: | -: | -: | -: |",
        "| 1 | 0 | 0 | 0 | 0 | 0 | $4.56 |",
      ].join("\n"));

      const result = await readHistoricalCostSummary(root, "slug-d", {
        logicalToolName: "sf_team_task",
        ownerTool: "sf_team_task",
      });

      expect(result.reportCount).toBe(1);
      expect(result.usage.costTotal).toBe(4.56);
      expect(result.usage.unknownCostCount).toBe(1);
    } finally {
      dispose();
    }
  });
});
