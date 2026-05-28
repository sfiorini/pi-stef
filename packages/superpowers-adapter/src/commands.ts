import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatTodos, clearTodos } from "./tools/todo-write.js";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("todos", {
    description: "Show current todo list",
    handler: async (_args: string, ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }) => {
      ctx.ui.notify(formatTodos(), "info");
    },
  });

  pi.registerCommand("todo-clear", {
    description: "Clear all todos",
    handler: async (_args: string, ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }) => {
      clearTodos();
      ctx.ui.notify("All todos cleared.", "info");
    },
  });
}
