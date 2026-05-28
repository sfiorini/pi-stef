import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { reportsFolderPath } from "@pi-stef/agent-workflows";

import type { AgentTokenUsage } from "../runtime/types";

export interface CostUsageTotal {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
  knownCostCount: number;
  unknownCostCount: number;
}

export interface CostSummary {
  prior: CostUsageTotal;
  settled: CostUsageTotal;
  current: CostUsageTotal;
  total: CostUsageTotal;
  priorRunCount: number;
  settledRunCount: number;
  inFlightRunCount: number;
}

export interface HistoricalCostScope {
  logicalToolName: string;
  ownerTool?: string;
  includeLegacyAutoReports?: boolean;
}

export interface HistoricalCostSummary {
  usage: CostUsageTotal;
  reportCount: number;
}

interface ParsedHistoricalReport {
  toolName: string;
  ownerTool?: string;
  usage: CostUsageTotal;
}

interface PerformanceReportSidecarLike {
  toolName?: unknown;
  ownerTool?: unknown;
  runUsage?: unknown;
}

export function emptyUsageTotal(): CostUsageTotal {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    knownCostCount: 0,
    unknownCostCount: 0,
  };
}

export function addUsage(a: CostUsageTotal, b: CostUsageTotal): CostUsageTotal {
  const knownCostCount = a.knownCostCount + b.knownCostCount;
  const costTotal = knownCostCount > 0 ? (a.costTotal ?? 0) + (b.costTotal ?? 0) : undefined;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    costTotal,
    knownCostCount,
    unknownCostCount: a.unknownCostCount + b.unknownCostCount,
  };
}

export function usageFromAgentUsage(usage?: AgentTokenUsage): CostUsageTotal | undefined {
  if (!usage) return undefined;
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.totalTokens;
  if (total === 0 && usage.costTotal === undefined) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costTotal: usage.costTotal,
    knownCostCount: usage.costTotal === undefined ? 0 : 1,
    unknownCostCount: usage.costTotal === undefined ? 1 : 0,
  };
}

export function composeCostSummary(
  prior: { usage: CostUsageTotal; reportCount: number },
  settledBySpawn: Map<string, CostUsageTotal>,
  inFlightBySpawn: Map<string, CostUsageTotal>,
): CostSummary {
  const settled = sumUsageTotals([...settledBySpawn.values()]);
  const inFlight = sumUsageTotals([...inFlightBySpawn.values()]);
  const current = addUsage(settled, inFlight);
  return {
    prior: prior.usage,
    settled,
    current,
    total: addUsage(prior.usage, current),
    priorRunCount: prior.reportCount,
    settledRunCount: settledBySpawn.size,
    inFlightRunCount: inFlightBySpawn.size,
  };
}

export function formatCost(value: number | undefined): string {
  if (value === undefined) return "";
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export function formatFinalCostSentence(summary: CostSummary | undefined): string | undefined {
  if (!summary || summary.total.knownCostCount === 0) return undefined;
  const total = formatCost(summary.total.costTotal);
  if (!total) return undefined;
  if (summary.total.unknownCostCount > 0) {
    return `Your total cost is at least ${total} (some agents did not report cost).`;
  }
  return `Your total cost is ${total}.`;
}

export async function readHistoricalCostSummary(
  repoRoot: string,
  slug: string,
  scope: HistoricalCostScope,
): Promise<HistoricalCostSummary> {
  const folder = reportsFolderPath(repoRoot, slug);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return { usage: emptyUsageTotal(), reportCount: 0 };
  }

  const byStem = new Map<string, { json?: string; md?: string }>();
  for (const name of names) {
    if (!/^performance-/.test(name)) continue;
    const ext = path.extname(name);
    if (ext !== ".json" && ext !== ".md") continue;
    const stem = name.slice(0, -ext.length);
    const entry = byStem.get(stem) ?? {};
    if (ext === ".json") entry.json = name;
    else entry.md = name;
    byStem.set(stem, entry);
  }

  let usage = emptyUsageTotal();
  let reportCount = 0;
  for (const entry of byStem.values()) {
    const parsed = entry.json
      ? await parseJsonReport(path.join(folder, entry.json)).catch(async () =>
        entry.md ? parseMarkdownReport(path.join(folder, entry.md)) : undefined)
      : entry.md
        ? await parseMarkdownReport(path.join(folder, entry.md))
        : undefined;
    if (!parsed || !historicalReportMatchesScope(parsed, scope)) continue;
    usage = addUsage(usage, parsed.usage);
    reportCount += 1;
  }

  return { usage, reportCount };
}

export function parseFormattedCost(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^\$([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function sumUsageTotals(usages: CostUsageTotal[]): CostUsageTotal {
  return usages.reduce((acc, usage) => addUsage(acc, usage), emptyUsageTotal());
}

function historicalReportMatchesScope(report: ParsedHistoricalReport, scope: HistoricalCostScope): boolean {
  if (report.ownerTool) return report.ownerTool === (scope.ownerTool ?? scope.logicalToolName);
  if (report.toolName === scope.logicalToolName) return true;
  return Boolean(
    scope.includeLegacyAutoReports
    && scope.logicalToolName === "sf_team_auto"
    && (report.toolName === "sf_team_plan" || report.toolName === "sf_team_implement"),
  );
}

async function parseJsonReport(filePath: string): Promise<ParsedHistoricalReport | undefined> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as PerformanceReportSidecarLike;
  const toolName = typeof raw.toolName === "string" ? raw.toolName : undefined;
  if (!toolName) return undefined;
  const ownerTool = typeof raw.ownerTool === "string" ? raw.ownerTool : undefined;
  const usage = costUsageTotalFromUnknown(raw.runUsage);
  if (!usage) return undefined;
  return { toolName, ownerTool, usage };
}

async function parseMarkdownReport(filePath: string): Promise<ParsedHistoricalReport | undefined> {
  const body = await readFile(filePath, "utf8");
  const h1 = body.match(/^# sf-team performance\s[-—]\s([^\n]+)$/m);
  const toolName = h1?.[1]?.trim();
  if (!toolName) return undefined;
  const ownerTool = body.match(/^- \*\*owner tool\*\*:\s*([^\n]+)$/m)?.[1]?.trim();
  const usage = parseMarkdownTokenUsage(body);
  if (!usage) return undefined;
  return { toolName, ownerTool, usage };
}

function parseMarkdownTokenUsage(body: string): CostUsageTotal | undefined {
  const heading = body.match(/^## Token Usage\s*$/m);
  if (!heading || heading.index === undefined) return undefined;
  const afterHeading = body.slice(heading.index + heading[0].length);
  const nextHeading = afterHeading.search(/\n## |\n# /);
  const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  const rows = section.split("\n").filter((line) => line.trim().startsWith("|"));
  const dataRows = rows.filter((line) => !/^\|\s*-/.test(line));
  const row = dataRows.at(-1);
  if (!row) return undefined;
  const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 7) return undefined;
  const cost = parseFormattedCost(cells[6]);
  const base = emptyUsageTotal();
  base.input = parseIntegerCell(cells[1]) ?? 0;
  base.output = parseIntegerCell(cells[2]) ?? 0;
  base.cacheRead = parseIntegerCell(cells[3]) ?? 0;
  base.cacheWrite = parseIntegerCell(cells[4]) ?? 0;
  base.totalTokens = parseIntegerCell(cells[5]) ?? 0;
  if (cost !== undefined) {
    base.costTotal = cost;
    base.knownCostCount = 1;
    base.unknownCostCount = 1;
  } else {
    base.unknownCostCount = 1;
  }
  return base;
}

function parseIntegerCell(value: string): number | undefined {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function costUsageTotalFromUnknown(value: unknown): CostUsageTotal | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberProp(value, "input") ?? 0;
  const output = numberProp(value, "output") ?? 0;
  const cacheRead = numberProp(value, "cacheRead") ?? 0;
  const cacheWrite = numberProp(value, "cacheWrite") ?? 0;
  const totalTokens = numberProp(value, "totalTokens") ?? 0;
  const costTotal = numberProp(value, "costTotal");
  const knownCostCount = numberProp(value, "knownCostCount") ?? (costTotal === undefined ? 0 : 1);
  const unknownCostCount = numberProp(value, "unknownCostCount") ?? (costTotal === undefined ? 1 : 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costTotal,
    knownCostCount,
    unknownCostCount,
  };
}

function numberProp(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
