import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowYaml } from "./schema.js";
import { generateScript } from "./generate.js";
import { validateFlowYaml } from "./validate.js";
import { skillDocPath } from "../messages.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { globalWorkflowsDir, projectWorkflowsDir } from "../paths.js";
import { loadFlowYaml } from "./load.js";

/**
 * Register a generated flow as a `/<name>` slash command. The command delegates
 * to sf_flow_auto (via a user-message directive) with the flow name + user args,
 * so the generated script runs end-to-end under the flow engine. The flow is
 * validated + generated eagerly so invalid flows fail at registration (not at
 * run time).
 */
export function registerGeneratedFlow(pi: ExtensionAPI, flow: FlowYaml): void {
  // Validate eagerly so semantic errors (fanout on skill/raw, missing agent, ...)
  // surface at registration, not as silently-incorrect generated code at runtime.
  const result = validateFlowYaml(flow);
  if (!result.ok) {
    throw new Error(`Cannot register flow "${flow.name}": ${result.errors.join("; ")}`);
  }
  generateScript(flow);
  const send =
    typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;

  pi.registerCommand(flow.name, {
    description: flow.description,
    handler: async (args: string, ctx) => {
      const trimmed = args.trim();
      const directive =
        trimmed.length > 0
          ? `Invoke the sf_flow_auto tool with workflow="${flow.name}" and input="${trimmed}". Then read the skill file at ${skillDocPath("sf-flow-auto")}.`
          : `Invoke the sf_flow_auto tool with workflow="${flow.name}". Ask for the input first, then read the skill file at ${skillDocPath("sf-flow-auto")}.`;

      if (!send) {
        ctx.ui?.notify?.(
          `flow: this pi runtime can't post slash-command output. Invoke sf_flow_auto with workflow="${flow.name}" directly.`,
          "warning",
        );
        return;
      }
      // When the agent is mid-stream, queue the directive as a follow-up so it
      // isn't dropped (mirrors pair/team slash-command handlers).
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      if (idle) {
        await send(directive);
      } else {
        await send(directive, { deliverAs: "followUp" });
      }
    },
  });
}

async function listYamls(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((f) => f.endsWith(".yaml")).map((f) => join(dir, f));
}

/**
 * Discover workflows in the global (`~/.pi/sf/flow/workflows`) and project
 * (`<repoRoot>/.pi/sf/flow/workflows`) dirs and register each as a `/<name>`
 * command via `registerGeneratedFlow`. Project flows override globals of the
 * same name. Per-file load/register errors are warned and skipped — one bad
 * workflow must not break the others. Best-effort, called at extension load.
 */
export async function registerDiscoveredFlows(
  pi: ExtensionAPI,
  opts: { repoRoot: string; home: string },
): Promise<void> {
  const map = new Map<string, FlowYaml>();
  // Global first, then project — so a project flow of the same name overwrites
  // the global default in the map (project overrides global).
  for (const dir of [globalWorkflowsDir(opts.home), projectWorkflowsDir(opts.repoRoot)]) {
    let files: string[];
    try {
      files = await listYamls(dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`flow: skipping workflow dir ${dir}: ${msg}`);
      continue;
    }
    for (const file of files) {
      try {
        const flow = await loadFlowYaml(file);
        map.set(flow.name, flow);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`flow: skipping workflow ${file}: ${msg}`);
      }
    }
  }
  for (const flow of map.values()) {
    try {
      registerGeneratedFlow(pi, flow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`flow: failed to register /${flow.name}: ${msg}`);
    }
  }
}
