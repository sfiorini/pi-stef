/**
 * @pi-stef/team is DEPRECATED in favor of @pi-stef/flow.
 *
 * `teamDeprecatedNotice` is prepended to every deprecated tool's first text
 * result; `teamDeprecatedDescriptionPrefix` is composed into each tool's
 * registered `description`. Tools with a direct flow replacement name it;
 * `sf_team_resume`/`sf_team_steer` carry prose guidance (no 1:1 tool).
 */

const MIGRATION_URL = "https://sfiorini.github.io/pi-stef/migrating-from-team-and-pair";

type Replacement =
  | { tool: string; cmd: string }
  | { guidance: string };

/** team tool → flow replacement (or guidance for resume/steer). */
const TEAM_REPLACEMENTS: Record<string, Replacement> = {
  sf_team_plan: { tool: "sf_flow_plan", cmd: "/sf-flow-plan" },
  sf_team_implement: { tool: "sf_flow_implement", cmd: "/sf-flow-implement" },
  sf_team_task: { tool: "sf_flow_auto", cmd: "/sf-flow-auto" },
  sf_team_auto: { tool: "sf_flow_auto", cmd: "/sf-flow-auto" },
  sf_team_followup: { tool: "sf_flow_plan", cmd: "/sf-flow-plan" },
  sf_team_resume: { guidance: "re-run `sf_flow_implement <slug>` to resume from the plan tracker" },
  sf_team_steer: { guidance: "use pi's native steering (steer the orchestrator mid-run)" },
};

function replacementClause(toolName: string): string {
  const r = TEAM_REPLACEMENTS[toolName];
  if (!r) return " Use @pi-stef/flow instead.";
  return "tool" in r ? ` Use ${r.tool} (${r.cmd}) instead.` : ` ${r.guidance}.`;
}

/** Banner prepended to every deprecated team tool's first text result. */
export function teamDeprecatedNotice(toolName: string): string {
  return `⚠️ @pi-stef/team is deprecated in favor of @pi-stef/flow.${replacementClause(toolName)} See: ${MIGRATION_URL}\n\n`;
}

/** Prefix for a deprecated team tool's registered description. */
export function teamDeprecatedDescriptionPrefix(toolName: string): string {
  const r = TEAM_REPLACEMENTS[toolName];
  if (r && "tool" in r) return `[DEPRECATED — use ${r.cmd}] `;
  return "[DEPRECATED — use @pi-stef/flow] ";
}

/**
 * Prepend the deprecation banner to a tool result's first text content.
 * Mutates and returns the same object (the result is freshly built by the
 * handler). Used via `.then((r) => prependTeamDeprecationNotice(name, r))`.
 */
export function prependTeamDeprecationNotice<T extends { content: Array<{ type: string; text: string }> }>(
  toolName: string,
  res: T,
): T {
  const first = res?.content?.[0];
  if (first && first.type === "text") {
    first.text = teamDeprecatedNotice(toolName) + first.text;
  }
  return res;
}
