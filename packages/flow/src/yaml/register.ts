import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowYaml } from "./schema.js";
import { generateScript } from "./generate.js";

/**
 * Register a generated flow as a `/<name>` slash command. The command delegates
 * to sf_flow_auto (via a user-message directive) with the flow name + user args,
 * so the generated script runs end-to-end under the flow engine. The script is
 * generated eagerly so invalid flows fail at registration (not at run time).
 */
export function registerGeneratedFlow(pi: ExtensionAPI, flow: FlowYaml): void {
  // Generate eagerly so errors surface at registration, not at run time.
  generateScript(flow);
  const send =
    typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;

  pi.registerCommand(flow.name, {
    description: flow.description,
    handler: async (args: string, ctx) => {
      const trimmed = args.trim();
      const directive =
        trimmed.length > 0
          ? `Invoke the sf_flow_auto tool with workflow="${flow.name}" and input="${trimmed}". Then load the skill named sf-flow-auto.`
          : `Invoke the sf_flow_auto tool with workflow="${flow.name}". Ask for the input first, then load the skill named sf-flow-auto.`;

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
        send(directive);
      } else {
        send(directive, { deliverAs: "followUp" });
      }
    },
  });
}
