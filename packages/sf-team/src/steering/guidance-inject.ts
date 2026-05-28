import type { WorkflowReporter } from "@pi-stef/agent-workflows";

import { MAX_INJECTED_GUIDANCE_CHARS } from "./guidance-sanitize";
import type { SteeringStore } from "./store";
import type { SteeringGuidance } from "./types";

export interface GuidanceInjectionFilter {
  workflowId: string;
  role: string;
  milestoneId?: string;
  storyId?: string;
}

export interface LoadActiveGuidanceOptions {
  maxChars?: number;
  reporter?: WorkflowReporter;
}

export interface LoadActiveGuidanceResult {
  lines: string[];
  truncated: boolean;
  selected: SteeringGuidance[];
}

const HEADING = "## Active Steering Guidance";

function matchesScope(row: SteeringGuidance, filter: GuidanceInjectionFilter): boolean {
  if (row.workflowId !== filter.workflowId) return false;
  switch (row.scope.kind) {
    case "workflow":
      return true;
    case "milestone":
      return !!filter.milestoneId && row.scope.target === filter.milestoneId;
    case "story":
      return !!filter.storyId && row.scope.target === filter.storyId;
    case "role":
      return row.scope.target === filter.role;
    default:
      return false;
  }
}

function formatGuidanceLine(row: SteeringGuidance): string {
  // The README/trust-boundary guarantee is that EVERY injected line
  // carries the provenance prefix. Multi-line guidance text would
  // otherwise produce unprefixed continuation lines; prefix them too
  // (the leading two spaces preserve Markdown-list continuation style).
  const prefix = `[steering ${row.source}:${row.instructionId}]`;
  const lines = row.text.split("\n");
  return lines
    .map((line, i) => (i === 0 ? `- ${prefix} ${line}` : `  ${prefix} ${line}`))
    .join("\n");
}

/**
 * Load active steering guidance from the durable store, filter to the
 * requesting agent's scope (workflow / milestone / story / role), and
 * render the lines that will be prepended to the agent prompt as the
 * "## Active Steering Guidance" section.
 *
 * Oldest entries are dropped first when the total injected text would
 * exceed `maxChars`. A reporter warning is emitted on truncation.
 */
export async function loadActiveSteeringGuidance(
  store: SteeringStore,
  filter: GuidanceInjectionFilter,
  options: LoadActiveGuidanceOptions = {},
): Promise<LoadActiveGuidanceResult> {
  const all = await store.listActiveGuidance();
  const scoped = all
    .filter((row) => matchesScope(row, filter))
    .sort((a, b) => a.appendedAt.localeCompare(b.appendedAt));

  const maxChars = options.maxChars ?? MAX_INJECTED_GUIDANCE_CHARS;
  const selected: SteeringGuidance[] = [];
  let totalChars = 0;
  // Walk newest-first; keep newest entries when overflow forces drops.
  for (const row of [...scoped].reverse()) {
    const line = formatGuidanceLine(row);
    const sep = selected.length > 0 ? 1 : 0;
    if (totalChars + sep + line.length > maxChars) continue;
    selected.push(row);
    totalChars += sep + line.length;
  }
  selected.reverse();

  const truncated = selected.length < scoped.length;
  if (truncated) {
    options.reporter?.message(
      "steering guidance truncated to fit prompt cap",
      { level: "warning" },
    );
  }

  return {
    lines: selected.map(formatGuidanceLine),
    truncated,
    selected,
  };
}

export function buildSteeringGuidanceSection(lines: string[]): string {
  if (lines.length === 0) return "";
  return [HEADING, ...lines].join("\n");
}

export function prependSteeringGuidanceSection(prompt: string, lines: string[]): string {
  const section = buildSteeringGuidanceSection(lines);
  if (!section) return prompt;
  return `${section}\n\n${prompt}`;
}

export { HEADING as ACTIVE_STEERING_GUIDANCE_HEADING };
