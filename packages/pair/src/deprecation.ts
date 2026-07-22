/**
 * @pi-stef/pair is DEPRECATED in favor of @pi-stef/flow.
 *
 * Each deprecated pair tool maps to a flow replacement. `pairDeprecatedNotice`
 * is prepended to every deprecated tool's first text result;
 * `pairDeprecatedDescriptionPrefix` is composed into each tool's registered
 * `description`.
 */

const MIGRATION_URL = "https://sfiorini.github.io/pi-stef/migrating-from-team-and-pair";

/** pair tool → flow replacement (tool name + slash command). */
const PAIR_REPLACEMENTS: Record<string, { tool: string; cmd: string }> = {
  sf_pair_plan: { tool: "sf_flow_plan", cmd: "/sf-flow-plan" },
  sf_pair_implement: { tool: "sf_flow_implement", cmd: "/sf-flow-implement" },
  sf_pair_task: { tool: "sf_flow_auto", cmd: "/sf-flow-auto" },
  sf_pair_finalize: { tool: "sf_flow_finalize", cmd: "/sf-flow-finalize" },
};

/** Banner prepended to every deprecated pair tool's first text result. */
export function pairDeprecatedNotice(toolName: string): string {
  const r = PAIR_REPLACEMENTS[toolName];
  const where = r ? ` Use ${r.tool} (${r.cmd}) instead.` : " Use @pi-stef/flow instead.";
  return `⚠️ @pi-stef/pair is deprecated in favor of @pi-stef/flow.${where} See: ${MIGRATION_URL}\n\n`;
}

/** Prefix for a deprecated pair tool's registered description. */
export function pairDeprecatedDescriptionPrefix(toolName: string): string {
  const r = PAIR_REPLACEMENTS[toolName];
  return r ? `[DEPRECATED — use ${r.cmd}] ` : "[DEPRECATED] ";
}

/**
 * Wrap a tool `execute` so the deprecation banner is prepended to the first
 * text content of its result. Returns a new execute function; the original is
 * unchanged.
 */
export function withPairDeprecationNotice(toolName: string): (execute: any) => any {
  return (execute: any) => async (...args: any[]) => {
    const res = await execute(...args);
    const first = res?.content?.[0];
    if (first && first.type === "text") {
      first.text = pairDeprecatedNotice(toolName) + first.text;
    }
    return res;
  };
}
