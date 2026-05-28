import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPORTS_FOLDER_NAME, reportsFolderPath } from "@pi-stef/agent-workflows";

import type { AgentContextUsage, AgentRun, TeamMember } from "../runtime/types";
import type { WorkflowProfile } from "../config/schema";
import {
  composeCostSummary,
  emptyUsageTotal,
  formatCost as formatSummaryCost,
  usageFromAgentUsage,
  type CostSummary,
  type CostUsageTotal,
} from "./cost";

export interface RecordedAgentRun {
  run: AgentRun;
  member?: Pick<TeamMember, "role" | "model" | "thinking">;
  agentId?: string;
}

export interface PerformanceReportInput {
  slug: string;
  toolName: string;
  ownerTool?: string;
  status?: "completed" | "failed";
  workflowProfile?: WorkflowProfile;
  reviewRoundLimits?: {
    maxRounds?: number;
    planMaxRounds?: number;
    implementationMaxRounds?: number;
  };
  startedAtMs: number;
  finishedAtMs: number;
  agentRuns: RecordedAgentRun[];
  costSummary?: CostSummary;
  error?: unknown;
}

interface PerformanceReportSidecar {
  schemaVersion: 1;
  slug: string;
  toolName: string;
  ownerTool: string;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  runUsage: CostUsageTotal;
  costSummary?: CostSummary;
}

export async function writePerformanceReport(
  repoRoot: string,
  input: PerformanceReportInput,
  opts?: { planFolder?: string },
): Promise<string | undefined> {
  const folder = opts?.planFolder
    ? path.join(opts.planFolder, REPORTS_FOLDER_NAME)
    : reportsFolderPath(repoRoot, input.slug);
  const stamp = new Date(input.finishedAtMs).toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(folder, `performance-${stamp}.md`);
  const jsonPath = path.join(folder, `performance-${stamp}.json`);
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(filePath, composePerformanceReport(input), "utf8");
    await writeFile(jsonPath, `${JSON.stringify(composePerformanceReportSidecar(input), null, 2)}\n`, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

export function composePerformanceReport(input: PerformanceReportInput): string {
  const totalMs = Math.max(0, input.finishedAtMs - input.startedAtMs);
  const ownerTool = input.ownerTool ?? input.toolName;
  const costSummary = input.costSummary ?? costSummaryFromRuns(input.agentRuns);
  const runUsage = costSummary.current;
  const lines: string[] = [
    `# sf-team performance — ${input.toolName}`,
    "",
    `- **slug**: ${input.slug}`,
    `- **owner tool**: ${ownerTool}`,
    `- **started**: ${new Date(input.startedAtMs).toISOString()}`,
    `- **finished**: ${new Date(input.finishedAtMs).toISOString()}`,
    `- **status**: ${input.status ?? "completed"}`,
    `- **wall time**: ${formatMs(totalMs)}`,
    `- **agent runs**: ${input.agentRuns.length}`,
    `- **run cost**: ${formatReportCost(runUsage)}`,
  ];
  if (costSummary.priorRunCount > 0) {
    lines.push(`- **prior cost baseline**: ${formatReportCost(costSummary.prior)}`);
  }
  lines.push(`- **total cost including prior**: ${formatReportCost(costSummary.total)}`);
  if (input.workflowProfile) lines.push(`- **workflow profile**: ${input.workflowProfile}`);
  const reviewLimits = formatReviewLimits(input.reviewRoundLimits);
  if (reviewLimits) lines.push(`- **review round limits**: ${reviewLimits}`);
  if (input.error) lines.push(`- **error**: ${escapeInline(describeError(input.error))}`);
  lines.push("");

  if (input.agentRuns.length === 0) {
    lines.push("No role-agent subprocesses were recorded for this run.");
    if (input.error) appendErrorSection(lines, input.error);
    return lines.join("\n");
  }

  lines.push(
    "| # | agent | role | model | state | duration | first text | handoff close | text deltas | tool calls | tokens | cost | context |",
    "| - | - | - | - | - | -: | -: | -: | -: | -: | -: | -: | -: |",
  );
  input.agentRuns.forEach((entry, index) => {
    const metrics = entry.run.metrics;
    lines.push(`| ${[
      index + 1,
      escapeCell(entry.agentId ?? entry.member?.role ?? "agent"),
      escapeCell(entry.member?.role ?? "?"),
      escapeCell(entry.member?.model ?? "?"),
      escapeCell(entry.run.state),
      formatMs(metrics.totalDurationMs),
      formatMs(metrics.timeToFirstTextDeltaMs),
      formatMs(metrics.timeFromAgentEndToCloseMs),
      entry.run.eventSummary.textDeltaCount,
      entry.run.toolCalls.length,
      formatTokens(entry.run.usage?.totalTokens),
      formatCost(entry.run.usage?.costTotal),
      formatContextUsage(entry.run.contextUsage),
    ].join(" | ")} |`);
  });

  appendUsageTotals(lines, input.agentRuns);
  appendSlowToolExecutions(lines, input.agentRuns);

  appendWallTimeAttribution(lines, input.agentRuns, totalMs);

  const byRole = summarizeByRole(input.agentRuns);
  const byPhase = summarizeByPhase(input.agentRuns);
  lines.push("", "## Phase Totals", "");
  lines.push("| phase | roles | runs | completed | total duration | avg duration |");
  lines.push("| - | - | -: | -: | -: | -: |");
  for (const row of byPhase) {
    lines.push(`| ${[
      escapeCell(row.phase),
      escapeCell([...row.roles].sort().join(", ")),
      row.runs,
      row.completed,
      formatMs(row.totalDurationMs),
      formatMs(row.runs > 0 ? Math.round(row.totalDurationMs / row.runs) : undefined),
    ].join(" | ")} |`);
  }

  lines.push("", "## Role Totals", "");
  lines.push("| role | runs | completed | total duration | avg duration |");
  lines.push("| - | -: | -: | -: | -: |");
  for (const row of byRole) {
    lines.push(`| ${[
      escapeCell(row.role),
      row.runs,
      row.completed,
      formatMs(row.totalDurationMs),
      formatMs(row.runs > 0 ? Math.round(row.totalDurationMs / row.runs) : undefined),
    ].join(" | ")} |`);
  }
  if (input.error) appendErrorSection(lines, input.error);

  return lines.join("\n");
}

function composePerformanceReportSidecar(input: PerformanceReportInput): PerformanceReportSidecar {
  const costSummary = input.costSummary ?? costSummaryFromRuns(input.agentRuns);
  return {
    schemaVersion: 1,
    slug: input.slug,
    toolName: input.toolName,
    ownerTool: input.ownerTool ?? input.toolName,
    status: input.status ?? "completed",
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(input.finishedAtMs).toISOString(),
    runUsage: costSummary.current,
    costSummary,
  };
}

function costSummaryFromRuns(entries: RecordedAgentRun[]): CostSummary {
  const settledBySpawn = new Map<string, CostUsageTotal>();
  entries.forEach((entry, index) => {
    const usage = usageFromAgentUsage(entry.run.usage);
    if (usage) settledBySpawn.set(entry.agentId ?? `agent-${index + 1}`, usage);
  });
  return composeCostSummary({ usage: emptyUsageTotal(), reportCount: 0 }, settledBySpawn, new Map());
}

function formatReportCost(usage: CostUsageTotal): string {
  if (usage.knownCostCount === 0) return "unavailable";
  const formatted = formatSummaryCost(usage.costTotal);
  return usage.unknownCostCount > 0 ? `at least ${formatted}` : formatted;
}

function appendWallTimeAttribution(lines: string[], entries: RecordedAgentRun[], wallTimeMs: number): void {
  const agentMs = entries.reduce((sum, entry) => sum + (entry.run.metrics.totalDurationMs ?? 0), 0);
  const unattributedMs = Math.max(0, wallTimeMs - agentMs);
  if (unattributedMs === 0) return;
  lines.push("", "## Wall-Time Attribution", "");
  lines.push(`- **agent subprocess time**: ${formatMs(agentMs)}`);
  lines.push(`- **non-agent / orchestration time**: ${formatMs(unattributedMs)} (verification gates, git operations, worktree operations, prompts, or other overhead)`);
}

function appendUsageTotals(lines: string[], entries: RecordedAgentRun[]): void {
  const withUsage = entries.filter((entry) => entry.run.usage);
  if (withUsage.length === 0) return;
  const total = withUsage.reduce(
    (acc, entry) => {
      const usage = entry.run.usage;
      if (!usage) return acc;
      acc.input += usage.input;
      acc.output += usage.output;
      acc.cacheRead += usage.cacheRead;
      acc.cacheWrite += usage.cacheWrite;
      acc.totalTokens += usage.totalTokens;
      if (usage.costTotal !== undefined) acc.costTotal += usage.costTotal;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 },
  );
  lines.push("", "## Token Usage", "");
  lines.push("| runs with usage | input | output | cache read | cache write | total tokens | cost |", "| -: | -: | -: | -: | -: | -: | -: |");
  lines.push(`| ${[
    withUsage.length,
    formatTokens(total.input),
    formatTokens(total.output),
    formatTokens(total.cacheRead),
    formatTokens(total.cacheWrite),
    formatTokens(total.totalTokens),
    formatCost(total.costTotal),
  ].join(" | ")} |`);
}

function appendSlowToolExecutions(lines: string[], entries: RecordedAgentRun[]): void {
  const tools = entries.flatMap((entry, runIndex) =>
    (entry.run.toolExecutions ?? []).map((tool) => ({
      agent: entry.agentId ?? entry.member?.role ?? `#${runIndex + 1}`,
      role: entry.member?.role ?? "?",
      ...tool,
    })),
  );
  if (tools.length === 0) return;
  const completed = tools.filter((tool) => tool.durationMs !== undefined);
  const totalMs = completed.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  lines.push("", "## Tool Execution Timing", "");
  lines.push(`- **observed tool executions**: ${tools.length}`);
  lines.push(`- **completed tool time**: ${formatMs(totalMs)}`);
  lines.push("", "| agent | role | tool | duration | command | error |", "| - | - | - | -: | - | - | ");
  for (const tool of completed.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 10)) {
    lines.push(`| ${[
      escapeCell(tool.agent),
      escapeCell(tool.role),
      escapeCell(tool.toolName),
      formatMs(tool.durationMs),
      escapeCell(truncateInline(tool.command ?? "", 100)),
      tool.isError ? "yes" : "",
    ].join(" | ")} |`);
  }
}

function summarizeByPhase(entries: RecordedAgentRun[]): {
  phase: string;
  roles: Set<string>;
  runs: number;
  completed: number;
  totalDurationMs: number;
}[] {
  const byPhase = new Map<string, { phase: string; roles: Set<string>; runs: number; completed: number; totalDurationMs: number }>();
  for (const entry of entries) {
    const role = entry.member?.role ?? "unknown";
    const phase = phaseForRole(role);
    const current = byPhase.get(phase) ?? { phase, roles: new Set<string>(), runs: 0, completed: 0, totalDurationMs: 0 };
    current.roles.add(role);
    current.runs += 1;
    if (entry.run.state === "completed") current.completed += 1;
    current.totalDurationMs += entry.run.metrics.totalDurationMs ?? 0;
    byPhase.set(phase, current);
  }
  const order = new Map([
    ["research", 0],
    ["planning", 1],
    ["implementation", 2],
    ["review", 3],
    ["other", 4],
  ]);
  return [...byPhase.values()].sort((a, b) => (order.get(a.phase) ?? 99) - (order.get(b.phase) ?? 99));
}

function phaseForRole(role: string): string {
  if (role === "researcher") return "research";
  if (role === "planner") return "planning";
  if (role === "developer") return "implementation";
  if (role === "reviewer") return "review";
  return "other";
}

function summarizeByRole(entries: RecordedAgentRun[]): {
  role: string;
  runs: number;
  completed: number;
  totalDurationMs: number;
}[] {
  const byRole = new Map<string, { role: string; runs: number; completed: number; totalDurationMs: number }>();
  for (const entry of entries) {
    const role = entry.member?.role ?? "unknown";
    const current = byRole.get(role) ?? { role, runs: 0, completed: 0, totalDurationMs: 0 };
    current.runs += 1;
    if (entry.run.state === "completed") current.completed += 1;
    current.totalDurationMs += entry.run.metrics.totalDurationMs ?? 0;
    byRole.set(role, current);
  }
  return [...byRole.values()].sort((a, b) => a.role.localeCompare(b.role));
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1_000) return `${value}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "";
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "";
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatContextUsage(value: AgentContextUsage | undefined): string {
  if (!value) return "";
  const tokens = value.tokens === null ? "unknown" : formatTokens(value.tokens);
  const window = formatTokens(value.contextWindow);
  const percent = value.percent === null || value.percent === undefined ? "" : `${value.percent.toFixed(1)}%`;
  if (tokens && window && percent) return `${tokens}/${window} (${percent})`;
  if (tokens && window) return `${tokens}/${window}`;
  return tokens || percent || "";
}

function truncateInline(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function escapeInline(value: string): string {
  return value.replace(/\n/g, " ");
}

function formatReviewLimits(limits: PerformanceReportInput["reviewRoundLimits"]): string | undefined {
  if (!limits) return undefined;
  const parts: string[] = [];
  if (limits.maxRounds !== undefined) parts.push(`fallback=${limits.maxRounds}`);
  if (limits.planMaxRounds !== undefined) parts.push(`plan=${limits.planMaxRounds}`);
  if (limits.implementationMaxRounds !== undefined) parts.push(`implementation=${limits.implementationMaxRounds}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function appendErrorSection(lines: string[], error: unknown): void {
  lines.push("", "## Failure", "");
  if (error instanceof Error) {
    lines.push(`- **name**: ${error.name}`);
    lines.push(`- **message**: ${escapeInline(error.message)}`);
    if (error.name === "MaxReviewRoundsError") {
      lines.push("- **review outcome**: max review rounds exhausted before approval");
    }
    return;
  }
  lines.push(`- **error**: ${escapeInline(String(error))}`);
}
