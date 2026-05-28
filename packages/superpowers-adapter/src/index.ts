import type { ExtensionAPI, BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTodoWriteTool, clearTodos } from "./tools/todo-write.js";
import { registerTaskTool } from "./tools/task.js";
import { registerSkillTool, resetSkillCache, readSkillContent, discoverSkills } from "./tools/skill.js";
import { registerCommands } from "./commands.js";

const USING_SUPERPOWERS_SKILL = "using-superpowers";

export default function (pi: ExtensionAPI): void {
  registerTodoWriteTool(pi);
  registerTaskTool(pi);
  registerSkillTool(pi);
  registerCommands(pi);

  pi.on("session_start", async () => {
    clearTodos();
    resetSkillCache();
  });

  pi.on("resources_discover", async () => {
    resetSkillCache();
  });

  pi.on(
    "before_agent_start",
    async (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ) => {
      const skills = discoverSkills(ctx.cwd);
      const skill = skills.get(USING_SUPERPOWERS_SKILL);

      if (!skill) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `[pi-superpowers-adapter] using-superpowers skill not found. Install superpowers: pi install https://github.com/obra/superpowers`,
            "warning",
          );
        }
        return;
      }

      const skillContent = readSkillContent(skill.path);
      if (!skillContent) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `[pi-superpowers-adapter] Failed to read using-superpowers skill from ${skill.path}`,
            "error",
          );
        }
        return;
      }

      return {
        systemPrompt: event.systemPrompt + "\n" + skillContent + "\n",
      };
    },
  );
}
