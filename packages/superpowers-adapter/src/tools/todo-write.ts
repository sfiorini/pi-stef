import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoStatus } from "../types.js";

const TodoWriteSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.String({ description: "Unique identifier for the todo item" }),
      content: Type.String({ description: "The content/description of the todo item" }),
      status: Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ],
        { description: "Status of the todo item" },
      ),
      priority: Type.Optional(
        Type.Union(
          [
            Type.Literal("high"),
            Type.Literal("medium"),
            Type.Literal("low"),
          ],
          { description: "Priority level (optional)" },
        ),
      ),
    }),
  ),
});

type TodoWriteInput = Static<typeof TodoWriteSchema>;

let todos: TodoItem[] = [];

export function clearTodos(): void {
  todos = [];
}

export function getTodos(): readonly TodoItem[] {
  return todos;
}

const statusIcon = (s: TodoStatus): string => {
  switch (s) {
    case "completed":
      return "✅";
    case "in_progress":
      return "🔄";
    case "pending":
      return "⭕";
  }
};

const priorityLabel = (p?: "high" | "medium" | "low"): string =>
  p ? `[${p.toUpperCase()}] ` : "";

export function formatTodos(): string {
  if (todos.length === 0) return "No todos. Use TodoWrite to create tasks.";
  const idWidth = todos.length >= 10 ? 2 : 1;
  const lines = todos.map(
    (t, i) =>
      `${String(i + 1).padStart(idWidth)}. ${statusIcon(t.status)} ${priorityLabel(t.priority)}${t.content}`,
  );
  const completed = todos.filter((t) => t.status === "completed").length;
  return `Todos (${completed}/${todos.length} completed):\n${lines.join("\n")}`;
}

export function registerTodoWriteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "TodoWrite",
    label: "TodoWrite",
    description:
      "Create, update, or replace the todo list for tracking task progress. Use this to track implementation tasks from plans.",
    promptSnippet: "Track tasks with status (pending, in_progress, completed)",
    promptGuidelines: [
      "Use TodoWrite when starting a multi-step task to track progress.",
      "Update todo status as you work through tasks: mark in_progress when starting, completed when done.",
    ],
    parameters: TodoWriteSchema,
    async execute(_toolCallId: string, params: TodoWriteInput) {
      todos = params.todos.map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        priority: t.priority,
      }));
      return {
        content: [{ type: "text" as const, text: formatTodos() }],
        details: { todoCount: todos.length },
      };
    },
  });
}
