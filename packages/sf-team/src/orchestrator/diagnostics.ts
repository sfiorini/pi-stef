import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { diagnosticsFolderPath } from "@pi-stef/agent-workflows";

import type { AgentRun } from "../runtime/types";

export interface DiagnosticsBundle {
  /** Slug of the active plan folder, if any. */
  slug?: string;
  /** Tool that was running (e.g. sf_team_implement). */
  toolName: string;
  /** Last-known agent runs at failure time. */
  agentRuns?: AgentRun[];
  /** Free-form error notes from the orchestrator. */
  notes?: string;
  /** Structured implementation metadata such as strategy, wave, lane, branch, worktree, or merge context. */
  details?: Record<string, unknown>;
  /** Original error object, if any. */
  error?: unknown;
}

/**
 * On error, write a diagnostics file under the plan folder (when slug is
 * known) so users have stderr tails + last events for post-mortem. Path:
 *
 *   ai_plan/<slug>/diagnostics/diagnostics-<isoTs>.log
 *
 * Returns the absolute file path on success, undefined when no slug is
 * available (caller should log to console in that case).
 */
export async function writeDiagnostics(
  repoRoot: string,
  bundle: DiagnosticsBundle,
  now: Date = new Date(),
): Promise<string | undefined> {
  if (!bundle.slug) return undefined;
  const folder = diagnosticsFolderPath(repoRoot, bundle.slug);
  await mkdir(folder, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(folder, `diagnostics-${stamp}.log`);
  const lines: string[] = [];
  lines.push(`# sf-team diagnostics — ${bundle.toolName} @ ${now.toISOString()}`);
  if (bundle.notes) lines.push("", "## notes", bundle.notes);
  const details = bundle.details ?? errorDetails(bundle.error);
  if (details) {
    lines.push("", "## details");
    for (const [key, value] of Object.entries(details)) {
      lines.push(`${key}: ${formatDetailValue(value)}`);
    }
  }
  if (bundle.error) {
    lines.push("", "## error");
    if (bundle.error instanceof Error) {
      lines.push(`name: ${bundle.error.name}`);
      lines.push(`message: ${bundle.error.message}`);
      if (bundle.error.stack) lines.push("stack:", bundle.error.stack);
    } else {
      lines.push(String(bundle.error));
    }
  }
  if (bundle.agentRuns && bundle.agentRuns.length > 0) {
    lines.push("", "## agent runs");
    for (const run of bundle.agentRuns) {
      lines.push("");
      lines.push(`- pid=${run.pid ?? "?"} state=${run.state} exitCode=${run.exitCode ?? "?"}`);
      if (run.reason) lines.push(`  reason: ${run.reason}`);
      lines.push("  metrics:");
      for (const [key, value] of Object.entries(run.metrics)) {
        if (value !== undefined) lines.push(`    ${key}=${value}`);
      }
      lines.push(`  events-compacted: ${run.eventsCompacted}`);
      lines.push("  event-summary:");
      lines.push(`    textDeltaCount=${run.eventSummary.textDeltaCount}`);
      lines.push(`    thinkingDeltaCount=${run.eventSummary.thinkingDeltaCount}`);
      lines.push(`    compactedEventCount=${run.eventSummary.compactedEventCount}`);
      // finalText is what the planner / developer / reviewer actually said —
      // the most useful field for post-mortem. Truncate so a runaway agent
      // can't blow up the diagnostics file.
      if (run.finalText && run.finalText.length > 0) {
        const truncated = run.finalText.length > 4096
          ? `${run.finalText.slice(0, 4096)}\n…[truncated; finalText was ${run.finalText.length} bytes]`
          : run.finalText;
        lines.push("  final-text:");
        lines.push(truncated.split("\n").map((l) => `    ${l}`).join("\n"));
      }
      const tail = run.stderrTail.split("\n").slice(-30).join("\n");
      if (tail.length > 0) {
        lines.push("  stderr-tail:", tail.split("\n").map((l) => `    ${l}`).join("\n"));
      }
      const lastEvents = run.events.slice(-20);
      if (lastEvents.length > 0) {
        lines.push("  last-events:");
        for (const e of lastEvents) {
          lines.push(`    - ${JSON.stringify(e)}`);
        }
      }
    }
  }
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  return details as Record<string, unknown>;
}
