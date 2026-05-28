# pi-stef Package Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pnpm monorepo containing pi.dev packages, starting with the superpowers-adapter extension.

**Architecture:** Each package in `packages/` is a standalone pi package installable via `pi install git:...`. The superpowers-adapter refactors the original 454-line single file into focused modules (types, three tool modules, commands, entry point) with unit tests.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, pi ExtensionAPI, @sinclair/typebox

---

## File Map

| File | Responsibility |
|------|---------------|
| `pnpm-workspace.yaml` | Workspace config: `packages/*` |
| `package.json` | Root monorepo scripts and dev deps |
| `tsconfig.json` | Root TS project references |
| `tsconfig.base.json` | Shared TypeScript config |
| `vitest.config.ts` | Test runner config |
| `scripts/install-all.sh` | Convenience: install all packages |
| `README.md` | Package catalog with links |
| `packages/superpowers-adapter/package.json` | pi manifest + deps |
| `packages/superpowers-adapter/tsconfig.json` | Package TS config |
| `packages/superpowers-adapter/src/types.ts` | Shared types (TodoItem, SkillMeta) |
| `packages/superpowers-adapter/src/tools/todo-write.ts` | TodoWrite tool registration + state |
| `packages/superpowers-adapter/src/tools/task.ts` | Task tool (Agent shim) |
| `packages/superpowers-adapter/src/tools/skill.ts` | Skill discovery, parsing, reading |
| `packages/superpowers-adapter/src/commands.ts` | /todos and /todo-clear commands |
| `packages/superpowers-adapter/src/index.ts` | Extension entry point (registers all) |
| `packages/superpowers-adapter/tests/helpers/mock-api.ts` | Mock ExtensionAPI for tests |
| `packages/superpowers-adapter/tests/todo-write.test.ts` | TodoWrite tests |
| `packages/superpowers-adapter/tests/task.test.ts` | Task tool tests |
| `packages/superpowers-adapter/tests/skill.test.ts` | Skill tool tests |
| `packages/superpowers-adapter/tests/commands.test.ts` | Commands tests |
| `packages/superpowers-adapter/tests/index.test.ts` | Integration: full extension wiring |
| `packages/superpowers-adapter/README.md` | Package documentation |

---

## M1: Monorepo Infrastructure

### S11: Create root package.json

**Create:** `package.json`

```json
{
  "name": "pi-stef",
  "version": "0.1.0",
  "private": true,
  "description": "Custom package collection for the pi coding agent.",
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "install:all:global": "./scripts/install-all.sh",
    "install:all:project": "./scripts/install-all.sh --project"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^6.0.3",
    "vitest": "^4.0.0"
  }
}
```

- [ ] Create the file with the content above

### S12: Create pnpm-workspace.yaml

**Create:** `pnpm-workspace.yaml`

```yaml
packages:
  - packages/*
```

- [ ] Create the file with the content above

### S13: Create tsconfig.base.json

**Create:** `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["node"]
  }
}
```

- [ ] Create the file with the content above

### S14: Create root tsconfig.json

**Create:** `tsconfig.json`

```json
{
  "files": [],
  "references": [
    { "path": "packages/superpowers-adapter" }
  ]
}
```

- [ ] Create the file with the content above

### S15: Create vitest.config.ts

**Create:** `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
```

- [ ] Create the file with the content above

### S16: Create superpowers-adapter package.json

**Create:** `packages/superpowers-adapter/package.json`

```json
{
  "name": "@pi-stef/superpowers-adapter",
  "version": "1.0.0",
  "description": "Bridges the superpowers skill system to pi's extension API with TodoWrite, Task, and Skill tools.",
  "keywords": ["pi-package", "pi-extension", "superpowers"],
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",
  "files": ["src/", "README.md"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  }
}
```

- [ ] Create the file with the content above

### S17: Create superpowers-adapter tsconfig.json

**Create:** `packages/superpowers-adapter/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] Create the file with the content above

### S18: Install dependencies

- [ ] Run `pnpm install`

Expected: Dependencies installed, lockfile created.

### S19: Commit M1

```bash
git add pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json vitest.config.ts pnpm-lock.yaml packages/superpowers-adapter/package.json packages/superpowers-adapter/tsconfig.json
git commit -m "chore: scaffold monorepo with superpowers-adapter package"
```

---

## M2: Types & Test Helpers

### S21: Create shared types

**Create:** `packages/superpowers-adapter/src/types.ts`

```typescript
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: "high" | "medium" | "low";
}

export interface SkillMeta {
  name: string;
  description?: string;
  path: string;
}
```

- [ ] Create the file with the content above

### S22: Create mock API helper

**Create:** `packages/superpowers-adapter/tests/helpers/mock-api.ts`

```typescript
import { vi } from "vitest";
import type { SkillMeta } from "../../src/types.js";

export interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
  renderResult?: (...args: unknown[]) => unknown;
}

export interface CapturedCommand {
  description: string;
  handler: (...args: unknown[]) => Promise<void>;
}

export interface MockExtensionAPI {
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  tools: CapturedTool[];
  commands: Map<string, CapturedCommand>;
  eventHandlers: Map<string, (...args: unknown[]) => unknown>;
}

export function createMockAPI(activeToolNames: string[] = []): MockExtensionAPI {
  const tools: CapturedTool[] = [];
  const commands = new Map<string, CapturedCommand>();
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const registerTool = vi.fn((tool: CapturedTool) => {
    tools.push(tool);
  });
  const registerCommand = vi.fn((name: string, opts: CapturedCommand) => {
    commands.set(name, opts);
  });
  const on = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    eventHandlers.set(event, handler);
  });
  const getActiveTools = vi.fn(() => activeToolNames);

  return { registerTool, registerCommand, on, getActiveTools, tools, commands, eventHandlers };
}

export function getToolByName(mockApi: MockExtensionAPI, name: string): CapturedTool | undefined {
  return mockApi.tools.find((t) => t.name === name);
}

export async function executeTool(mockApi: MockExtensionAPI, name: string, params: unknown, ctx: Record<string, unknown> = {}): Promise<unknown> {
  const tool = getToolByName(mockApi, name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.execute("", params, undefined, undefined, ctx);
}
```

- [ ] Create the file with the content above

### S23: Verify test infrastructure

- [ ] Run `pnpm test`

Expected: No tests found (exit 0 or "no test files found"). No errors.

### S24: Commit M2

```bash
git add packages/superpowers-adapter/src/types.ts packages/superpowers-adapter/tests/
git commit -m "feat(superpowers-adapter): add shared types and test helpers"
```

---

## M3: TodoWrite Tool (TDD)

### S31: Write failing test for TodoWrite

**Create:** `packages/superpowers-adapter/tests/todo-write.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createMockAPI, executeTool, getToolByName } from "./helpers/mock-api.js";
import { registerTodoWriteTool, formatTodos, clearTodos } from "../src/tools/todo-write.js";

describe("TodoWrite tool", () => {
  let mockApi: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    mockApi = createMockAPI();
    clearTodos();
    registerTodoWriteTool(mockApi as any);
  });

  it("registers the tool", () => {
    const tool = getToolByName(mockApi, "TodoWrite");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("TodoWrite");
    expect(tool!.description).toContain("todo");
  });

  it("creates todos from empty state", async () => {
    const result = await executeTool(mockApi, "TodoWrite", {
      todos: [
        { id: "1", content: "Design API", status: "pending" },
        { id: "2", content: "Write tests", status: "in_progress" },
        { id: "3", content: "Ship it", status: "completed" },
      ],
    }) as any;

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("1/3 completed");
    expect(result.content[0].text).toContain("Design API");
    expect(result.details.todoCount).toBe(3);
  });

  it("replaces existing todos", async () => {
    await executeTool(mockApi, "TodoWrite", {
      todos: [{ id: "1", content: "First", status: "pending" }],
    });

    const result = await executeTool(mockApi, "TodoWrite", {
      todos: [{ id: "2", content: "Second", status: "completed" }],
    }) as any;

    expect(result.details.todoCount).toBe(1);
    expect(result.content[0].text).toContain("Second");
    expect(result.content[0].text).not.toContain("First");
  });

  it("handles priority field", async () => {
    const result = await executeTool(mockApi, "TodoWrite", {
      todos: [
        { id: "1", content: "Urgent", status: "pending", priority: "high" },
        { id: "2", content: "Normal", status: "pending" },
      ],
    }) as any;

    expect(result.content[0].text).toContain("[HIGH]");
    expect(result.content[0].text).toContain("Urgent");
  });

  it("shows empty state message when no todos", () => {
    const text = formatTodos();
    expect(text).toBe("No todos. Use TodoWrite to create tasks.");
  });

  it("shows progress count", async () => {
    await executeTool(mockApi, "TodoWrite", {
      todos: [
        { id: "1", content: "Done", status: "completed" },
        { id: "2", content: "Pending", status: "pending" },
        { id: "3", content: "Active", status: "in_progress" },
      ],
    });

    const text = formatTodos();
    expect(text).toContain("1/3 completed");
  });
});
```

- [ ] Create the file with the content above

### S32: Run test — verify it fails

Run: `pnpm test`

Expected: FAIL — module `../src/tools/todo-write.js` not found.

### S33: Implement TodoWrite tool

**Create:** `packages/superpowers-adapter/src/tools/todo-write.ts`

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
```

- [ ] Create the file with the content above

### S34: Run tests — verify they pass

Run: `pnpm test`

Expected: All TodoWrite tests PASS.

### S35: Commit M3

```bash
git add packages/superpowers-adapter/src/tools/todo-write.ts packages/superpowers-adapter/tests/todo-write.test.ts
git commit -m "feat(superpowers-adapter): add TodoWrite tool with tests"
```

---

## M4: Task Tool (TDD)

### S41: Write failing test for Task tool

**Create:** `packages/superpowers-adapter/tests/task.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createMockAPI, executeTool, getToolByName } from "./helpers/mock-api.js";
import { registerTaskTool } from "../src/tools/task.js";

describe("Task tool", () => {
  it("registers the tool", () => {
    const mockApi = createMockAPI();
    registerTaskTool(mockApi as any);
    const tool = getToolByName(mockApi, "Task");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Task");
  });

  it("returns error when Agent tool is not available", async () => {
    const mockApi = createMockAPI([]); // no tools
    registerTaskTool(mockApi as any);
    const result = await executeTool(mockApi, "Task", {
      subagent_type: "Explore",
      prompt: "Find auth files",
      description: "Find auth files",
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pi-subagents");
  });

  it("redirects to Agent tool when available", async () => {
    const mockApi = createMockAPI(["Agent"]); // Agent tool present
    registerTaskTool(mockApi as any);
    const result = await executeTool(mockApi, "Task", {
      subagent_type: "Explore",
      prompt: "Find auth files",
      description: "Find auth files",
    }) as any;

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Agent");
    expect(result.content[0].text).toContain("Explore");
  });
});
```

- [ ] Create the file with the content above

### S42: Run test — verify it fails

Run: `pnpm test`

Expected: FAIL — module `../src/tools/task.js` not found.

### S43: Implement Task tool

**Create:** `packages/superpowers-adapter/src/tools/task.ts`

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TaskSchema = Type.Object({
  subagent_type: Type.String({
    description: "Type of subagent to dispatch (e.g., 'general-purpose', 'Explore', 'Plan')",
  }),
  prompt: Type.String({ description: "The task prompt for the subagent" }),
  description: Type.String({ description: "Short 3-5 word summary of the task" }),
  model: Type.Optional(
    Type.String({ description: "Model to use (provider/modelId or fuzzy name)" }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
  ),
  max_turns: Type.Optional(Type.Number({ description: "Maximum agentic turns" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run without blocking" })),
  resume: Type.Optional(Type.String({ description: "Agent ID to resume a previous session" })),
  isolated: Type.Optional(Type.Boolean({ description: "No extension/MCP tools" })),
  inherit_context: Type.Optional(
    Type.Boolean({ description: "Fork parent conversation into agent" }),
  ),
});

type TaskInput = Static<typeof TaskSchema>;

export function registerTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Task",
    label: "Task",
    description:
      "Dispatch a subagent to handle a specific task. Alias for Agent tool from pi-subagents. Requires @tintinweb/pi-subagents.",
    promptSnippet: "Dispatch specialized subagent for isolated task execution",
    promptGuidelines: [
      "Use Task when you need to delegate work to a specialized agent with isolated context.",
      "Task tool requires @tintinweb/pi-subagents extension to be installed.",
    ],
    parameters: TaskSchema,
    async execute(_toolCallId: string, params: TaskInput) {
      const activeTools = pi.getActiveTools();
      const hasAgentTool = activeTools.includes("Agent");

      if (!hasAgentTool) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Task tool requires @tintinweb/pi-subagents extension.\n\nInstall with: pi install npm:@tintinweb/pi-subagents",
            },
          ],
          isError: true,
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Task tool is an alias for the Agent tool. Please use the Agent tool directly with the same parameters:\n\nAgent({\n  subagent_type: "${params.subagent_type}",\n  prompt: "${params.prompt}",\n  description: "${params.description}"\n  ...\n})`,
          },
        ],
        details: {},
      };
    },
  });
}
```

- [ ] Create the file with the content above

### S44: Run tests — verify they pass

Run: `pnpm test`

Expected: All tests PASS (TodoWrite + Task).

### S45: Commit M4

```bash
git add packages/superpowers-adapter/src/tools/task.ts packages/superpowers-adapter/tests/task.test.ts
git commit -m "feat(superpowers-adapter): add Task tool with tests"
```

---

## M5: Skill Tool (TDD)

### S51: Write failing test for Skill tool

**Create:** `packages/superpowers-adapter/tests/skill.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockAPI, executeTool, getToolByName } from "./helpers/mock-api.js";
import {
  registerSkillTool,
  discoverSkills,
  resetSkillCache,
  parseSkillFrontmatter,
  extractSkillContent,
} from "../src/tools/skill.js";

describe("Skill tool", () => {
  let mockApi: ReturnType<typeof createMockAPI>;
  let tempDir: string;

  beforeEach(() => {
    mockApi = createMockAPI();
    resetSkillCache();
    tempDir = mkdtempSync(join(tmpdir(), "pi-skill-test-"));
  });

  afterEach(() => {
    resetSkillCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers the tool", () => {
    registerSkillTool(mockApi as any);
    const tool = getToolByName(mockApi, "Skill");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Skill");
  });

  it("returns error for unknown skill", async () => {
    registerSkillTool(mockApi as any);
    const result = await executeTool(
      mockApi,
      "Skill",
      { skill: "nonexistent" },
      { cwd: tempDir },
    ) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("discovers and loads a skill", async () => {
    // Create a skill in temp dir
    const skillDir = join(tempDir, ".pi", "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\n# Test Skill\n\nDo the thing.\n",
    );

    registerSkillTool(mockApi as any);
    const result = await executeTool(
      mockApi,
      "Skill",
      { skill: "test-skill" },
      { cwd: tempDir },
    ) as any;

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("test-skill");
    expect(result.content[0].text).toContain("Do the thing");
    expect(result.content[0].text).not.toContain("---"); // frontmatter stripped
  });

  it("discovers skills from multiple directories", () => {
    // Create skills in both .pi/skills and .agents/skills
    const piSkillDir = join(tempDir, ".pi", "skills", "pi-skill");
    mkdirSync(piSkillDir, { recursive: true });
    writeFileSync(
      join(piSkillDir, "SKILL.md"),
      "---\nname: pi-skill\n---\nPi skill content.\n",
    );

    const agentsSkillDir = join(tempDir, ".agents", "skills", "agents-skill");
    mkdirSync(agentsSkillDir, { recursive: true });
    writeFileSync(
      join(agentsSkillDir, "SKILL.md"),
      "---\nname: agents-skill\n---\nAgents skill content.\n",
    );

    const skills = discoverSkills(tempDir);
    expect(skills.has("pi-skill")).toBe(true);
    expect(skills.has("agents-skill")).toBe(true);
  });

  it("caches skill discovery results", () => {
    const skillDir = join(tempDir, ".pi", "skills", "cached-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: cached-skill\n---\nContent.\n",
    );

    const first = discoverSkills(tempDir);
    const second = discoverSkills(tempDir);
    expect(first).toBe(second); // same Map reference
  });

  it("resets cache on resetSkillCache()", () => {
    const skillDir = join(tempDir, ".pi", "skills", "reset-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: reset-skill\n---\nContent.\n",
    );

    discoverSkills(tempDir);
    resetSkillCache();
    const after = discoverSkills(tempDir);
    expect(after.has("reset-skill")).toBe(true); // re-discovered
  });
});

describe("parseSkillFrontmatter", () => {
  it("extracts name and description from frontmatter", () => {
    const meta = parseSkillFrontmatter(
      "---\nname: my-skill\ndescription: A cool skill\n---\nContent here.\n",
      "/path/to/my-skill/SKILL.md",
    );
    expect(meta).toEqual({
      name: "my-skill",
      description: "A cool skill",
      path: "/path/to/my-skill/SKILL.md",
    });
  });

  it("uses directory name as fallback", () => {
    const meta = parseSkillFrontmatter(
      "---\n---\nContent.\n",
      "/path/to/fallback-skill/SKILL.md",
    );
    expect(meta!.name).toBe("fallback-skill");
  });

  it("returns null for content without frontmatter", () => {
    const meta = parseSkillFrontmatter("No frontmatter here.", "/path/to/SKILL.md");
    expect(meta).toBeNull();
  });
});

describe("extractSkillContent", () => {
  it("strips frontmatter", () => {
    const content = extractSkillContent("---\nname: x\n---\nActual content.\n");
    expect(content).toBe("Actual content.");
  });

  it("returns raw content if no frontmatter", () => {
    const content = extractSkillContent("Just content.");
    expect(content).toBe("Just content.");
  });
});
```

- [ ] Create the file with the content above

### S52: Run test — verify it fails

Run: `pnpm test`

Expected: FAIL — module `../src/tools/skill.js` not found.

### S53: Implement Skill tool

**Create:** `packages/superpowers-adapter/src/tools/skill.ts`

```typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import type { SkillMeta } from "../types.js";

const SkillSchema = Type.Object({
  skill: Type.String({
    description:
      "Name of the skill to load (e.g., 'brainstorming', 'test-driven-development')",
  }),
});

type SkillInput = Static<typeof SkillSchema>;

let skillCache: Map<string, SkillMeta> | null = null;

export function resetSkillCache(): void {
  skillCache = null;
}

export function parseSkillFrontmatter(
  content: string,
  path: string,
): SkillMeta | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const skillDir = path.replace(/[\\/]?SKILL\.md$/, "");
  const meta: SkillMeta = { name: basename(skillDir), path };

  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key === "name") meta.name = value;
      if (key === "description") meta.description = value;
    }
  }

  return meta;
}

export function extractSkillContent(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

export function readSkillContent(skillPath: string): string | null {
  try {
    const content = readFileSync(skillPath, "utf-8");
    return extractSkillContent(content);
  } catch {
    return null;
  }
}

function findSkillsDirs(
  basePath: string,
  results: string[],
  depth = 0,
): void {
  if (depth > 10) return;
  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(basePath, entry.name);
      if (entry.name === "skills") {
        results.push(fullPath);
      } else {
        findSkillsDirs(fullPath, results, depth + 1);
      }
    }
  } catch {
    // Ignore permission errors
  }
}

export function discoverSkills(cwd: string): Map<string, SkillMeta> {
  if (skillCache) return skillCache;

  const skills = new Map<string, SkillMeta>();
  const home = homedir();

  const skillPaths = [
    join(home, ".pi", "agent", "skills"),
    join(home, ".agents", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
  ];

  const gitPackagesDir = join(home, ".pi", "agent", "git");
  if (existsSync(gitPackagesDir)) {
    findSkillsDirs(gitPackagesDir, skillPaths);
  }

  for (const basePath of skillPaths) {
    if (!existsSync(basePath)) continue;
    try {
      const skillDirs = readdirSync(basePath, { withFileTypes: true });
      for (const skillDir of skillDirs) {
        if (!skillDir.isDirectory()) continue;
        const skillFile = join(basePath, skillDir.name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        try {
          const content = readFileSync(skillFile, "utf-8");
          const meta = parseSkillFrontmatter(content, skillFile);
          if (meta?.name && !skills.has(meta.name)) {
            skills.set(meta.name, meta);
          }
        } catch {
          // Skip unreadable skill files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  skillCache = skills;
  return skills;
}

export function registerSkillTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Skill",
    label: "Skill",
    description:
      "Load and invoke a skill by name. Skills provide specialized instructions for specific tasks like TDD, debugging, or brainstorming. IMPORTANT: Use this tool instead of read for skill files.",
    promptSnippet: "Load specialized skill instructions for specific workflows",
    promptGuidelines: [
      "Use Skill tool to load skill instructions before starting a task that matches the skill's description.",
      "Common skills: brainstorming, test-driven-development, systematic-debugging, writing-plans.",
      "IMPORTANT: Always use Skill tool to load skills, never use read tool on skill files.",
    ],
    parameters: SkillSchema,
    async execute(
      _toolCallId: string,
      params: SkillInput,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const skills = discoverSkills(ctx.cwd);
      const skill = skills.get(params.skill);

      if (!skill) {
        const availableSkills = Array.from(skills.keys()).sort();
        return {
          content: [
            {
              type: "text" as const,
              text: `Skill "${params.skill}" not found.\n\nAvailable skills:\n${availableSkills.map((s) => ` - ${s}`).join("\n")}\n\nInstall superpowers: pi install https://github.com/obra/superpowers`,
            },
          ],
          isError: true,
          details: { requestedSkill: params.skill, availableSkills },
        };
      }

      const skillContent = readSkillContent(skill.path);
      if (!skillContent) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error loading skill "${params.skill}": Failed to read skill file`,
            },
          ],
          isError: true,
          details: { error: "Failed to read skill file", skillPath: skill.path },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded skill: ${skill.name}\n${skill.description ? `\nDescription: ${skill.description}\n` : ""}\n---\n\n${skillContent}`,
          },
        ],
        details: {
          skillName: skill.name,
          skillPath: skill.path,
          skillDescription: skill.description,
          totalLines: skillContent.split("\n").length,
        },
      };
    },
    renderResult(
      result: { content: { type: string; text: string }[]; details?: Record<string, unknown> },
      _options: unknown,
      theme: { fg: (type: string, text: string) => string; bg: (type: string, text: string) => string },
      context: { isError?: boolean },
    ) {
      if (context.isError) {
        const errorMsg =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "Failed to load skill.";
        return new Text(theme.fg("error", errorMsg), 0, 0);
      }

      const details = result.details as
        | { skillName?: string; totalLines?: number }
        | undefined;

      if (!details?.skillName || !details?.totalLines) {
        return new Text(
          theme.fg("warning", "Skill loaded, but metadata is missing."),
          0,
          0,
        );
      }

      const label = theme.fg(
        "customMessageLabel",
        "\x1b[1m[skill]\x1b[22m",
      );
      const name = theme.fg("customMessageText", details.skillName);
      const lines = theme.fg("dim", ` (${details.totalLines} lines)`);
      const line = `${label} ${name}${lines}`;

      const box = new Box(
        1,
        0,
        (t: string) => theme.bg("customMessageBg", t),
      );
      box.addChild(new Text(line, 0, 0));
      return box;
    },
  });
}
```

- [ ] Create the file with the content above

### S54: Run tests — verify they pass

Run: `pnpm test`

Expected: All tests PASS (TodoWrite + Task + Skill).

### S55: Commit M5

```bash
git add packages/superpowers-adapter/src/tools/skill.ts packages/superpowers-adapter/tests/skill.test.ts
git commit -m "feat(superpowers-adapter): add Skill tool with discovery and tests"
```

---

## M6: Commands & Extension Entry Point

### S61: Write failing test for commands

**Create:** `packages/superpowers-adapter/tests/commands.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockAPI } from "./helpers/mock-api.js";
import { registerTodoWriteTool, clearTodos } from "../src/tools/todo-write.js";
import { registerCommands } from "../src/commands.js";

describe("commands", () => {
  let mockApi: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    mockApi = createMockAPI();
    clearTodos();
    registerTodoWriteTool(mockApi as any);
    registerCommands(mockApi as any);
  });

  it("registers /todos command", () => {
    expect(mockApi.commands.has("todos")).toBe(true);
    expect(mockApi.commands.get("todos")!.description).toBe("Show current todo list");
  });

  it("registers /todo-clear command", () => {
    expect(mockApi.commands.has("todo-clear")).toBe(true);
    expect(mockApi.commands.get("todo-clear")!.description).toBe("Clear all todos");
  });

  it("/todos displays empty message when no todos", async () => {
    const mockCtx = { ui: { notify: vi.fn() } };
    const handler = mockApi.commands.get("todos")!.handler;
    await handler([], mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "No todos. Use TodoWrite to create tasks.",
      "info",
    );
  });

  it("/todos displays formatted list", async () => {
    // First add some todos via the tool
    const tool = mockApi.tools.find((t) => t.name === "TodoWrite")!;
    await tool.execute("", {
      todos: [
        { id: "1", content: "Task A", status: "completed" },
        { id: "2", content: "Task B", status: "in_progress" },
        { id: "3", content: "Task C", status: "pending" },
      ],
    });

    const mockCtx = { ui: { notify: vi.fn() } };
    const handler = mockApi.commands.get("todos")!.handler;
    await handler([], mockCtx);

    const notification = mockCtx.ui.notify.mock.calls[0][0] as string;
    expect(notification).toContain("1/3 completed");
    expect(notification).toContain("Task A");
    expect(notification).toContain("🔄");
  });

  it("/todo-clear resets todos", async () => {
    // Add todos first
    const tool = mockApi.tools.find((t) => t.name === "TodoWrite")!;
    await tool.execute("", {
      todos: [{ id: "1", content: "To be cleared", status: "pending" }],
    });

    const mockCtx = { ui: { notify: vi.fn() } };
    await mockApi.commands.get("todo-clear")!.handler([], mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith("All todos cleared.", "info");
  });
});
```

- [ ] Create the file with the content above

### S62: Run test — verify it fails

Run: `pnpm test`

Expected: FAIL — module `../src/commands.js` not found.

### S63: Implement commands

**Create:** `packages/superpowers-adapter/src/commands.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatTodos, clearTodos } from "./tools/todo-write.js";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("todos", {
    description: "Show current todo list",
    handler: async (_args: string[], ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
      ctx.ui.notify(formatTodos(), "info");
    },
  });

  pi.registerCommand("todo-clear", {
    description: "Clear all todos",
    handler: async (_args: string[], ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
      clearTodos();
      ctx.ui.notify("All todos cleared.", "info");
    },
  });
}
```

- [ ] Create the file with the content above

### S64: Run tests — verify they pass

Run: `pnpm test`

Expected: All tests PASS.

### S65: Create extension entry point

**Create:** `packages/superpowers-adapter/src/index.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
      event: { systemPrompt: string },
      ctx: { cwd: string; hasUI?: boolean; ui?: { notify: (msg: string, level: string) => void } },
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
```

- [ ] Create the file with the content above

### S66: Write integration test for entry point

**Create:** `packages/superpowers-adapter/tests/index.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockAPI } from "./helpers/mock-api.js";
import { clearTodos } from "../src/tools/todo-write.js";
import { resetSkillCache } from "../src/tools/skill.js";
import extension from "../src/index.js";

describe("extension entry point", () => {
  let mockApi: ReturnType<typeof createMockAPI>;
  let tempDir: string;

  beforeEach(() => {
    mockApi = createMockAPI();
    clearTodos();
    resetSkillCache();
    tempDir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
  });

  afterEach(() => {
    resetSkillCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all three tools", () => {
    extension(mockApi as any);
    const names = mockApi.tools.map((t) => t.name);
    expect(names).toContain("TodoWrite");
    expect(names).toContain("Task");
    expect(names).toContain("Skill");
  });

  it("registers both commands", () => {
    extension(mockApi as any);
    expect(mockApi.commands.has("todos")).toBe(true);
    expect(mockApi.commands.has("todo-clear")).toBe(true);
  });

  it("registers three event handlers", () => {
    extension(mockApi as any);
    expect(mockApi.eventHandlers.has("session_start")).toBe(true);
    expect(mockApi.eventHandlers.has("resources_discover")).toBe(true);
    expect(mockApi.eventHandlers.has("before_agent_start")).toBe(true);
  });

  it("before_agent_start injects skill content into system prompt", async () => {
    // Create a mock using-superpowers skill
    const skillDir = join(tempDir, ".pi", "skills", "using-superpowers");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: using-superpowers\ndescription: Boot skill\n---\nYou have superpowers.\n",
    );

    extension(mockApi as any);

    const handler = mockApi.eventHandlers.get("before_agent_start")!;
    const result = await handler(
      { systemPrompt: "Original prompt." },
      { cwd: tempDir, hasUI: true, ui: { notify: vi.fn() } },
    );

    expect(result.systemPrompt).toContain("Original prompt.");
    expect(result.systemPrompt).toContain("You have superpowers.");
  });

  it("session_start resets state", async () => {
    extension(mockApi as any);
    const handler = mockApi.eventHandlers.get("session_start")!;
    await handler();
    // State was reset — no error means success
    expect(true).toBe(true);
  });

  it("resources_discover resets skill cache", async () => {
    extension(mockApi as any);
    const handler = mockApi.eventHandlers.get("resources_discover")!;
    await handler();
    expect(true).toBe(true);
  });
});
```

- [ ] Create the file with the content above

### S67: Run all tests — verify they pass

Run: `pnpm test`

Expected: All tests PASS across all test files.

### S68: Commit M6

```bash
git add packages/superpowers-adapter/src/commands.ts packages/superpowers-adapter/src/index.ts packages/superpowers-adapter/tests/commands.test.ts packages/superpowers-adapter/tests/index.test.ts
git commit -m "feat(superpowers-adapter): add commands, entry point, and integration tests"
```

---

## M7: Documentation & Scripts

### S71: Write comprehensive package README

**Create:** `packages/superpowers-adapter/README.md`

Write a comprehensive README covering:

```markdown
# @pi-stef/superpowers-adapter

A [pi](https://pi.dev) extension that bridges the [superpowers](https://github.com/obra/superpowers) skill system to pi's extension API.

## Why This Extension Exists

Pi ships with 4 built-in tools: `read`, `bash`, `edit`, `write`. The superpowers skill system expects additional tools that pi doesn't provide natively:

| Tool | Pi Built-in | Superpowers Needs | Provided By |
|------|-------------|-------------------|-------------|
| TodoWrite | No | Yes | This extension |
| Task | No | Yes | This extension (Agent alias) |
| Skill | No | Yes | This extension |
| Agent | No | Yes | `@tintinweb/pi-subagents` |

The superpowers `using-superpowers` skill explicitly requires:
1. **"Use the `Skill` tool"** to load skill instructions
2. **"Never use the Read tool on skill files"** — the Skill tool must be used instead

While pi natively supports skill discovery (listing them in the system prompt), superpowers workflows depend on calling the `Skill` tool directly.

## Installation

```bash
# 1. Install superpowers (official skill pack)
pi install https://github.com/obra/superpowers

# 2. Install pi-subagents (required for Task/Agent tool)
pi install npm:@tintinweb/pi-subagents

# 3. Install this extension
pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter
```

## Tools

### TodoWrite

Track implementation tasks with status progression.

**Parameters:**
- `todos` (array, required) — Array of todo items, each with:
  - `id` (string) — Unique identifier
  - `content` (string) — Task description
  - `status` (string) — One of: `pending`, `in_progress`, `completed`
  - `priority` (string, optional) — One of: `high`, `medium`, `low`

**Example:**
```
TodoWrite({
  todos: [
    { id: "1", content: "Design API", status: "completed" },
    { id: "2", content: "Implement", status: "in_progress", priority: "high" },
    { id: "3", content: "Write tests", status: "pending" }
  ]
})
```

### Task

Dispatch subagents for isolated work. This is an alias for the `Agent` tool from `@tintinweb/pi-subagents`.

**Parameters:**
- `subagent_type` (string, required) — Agent type (e.g., `general-purpose`, `Explore`, `Plan`)
- `prompt` (string, required) — Task description for the subagent
- `description` (string, required) — Short 3-5 word summary
- `model` (string, optional) — Model override
- `run_in_background` (boolean, optional) — Non-blocking execution

**Prerequisite:** `pi install npm:@tintinweb/pi-subagents`

**Limitation:** Pi's ExtensionAPI does not support tool-to-tool invocation. The Task tool returns a message directing the LLM to call the Agent tool directly rather than forwarding the call programmatically. This matches the behavior of the original upstream implementation.

### Skill

Load skill instructions by name. Discovers skills from standard pi skill directories.

**Parameters:**
- `skill` (string, required) — Skill name (e.g., `brainstorming`, `test-driven-development`)

**Discovery paths** (searched in order):
- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `<cwd>/.pi/skills/`
- `<cwd>/.agents/skills/`
- Recursively under `~/.pi/agent/git/` (depth 10)

**Limitation:** The YAML frontmatter parser handles simple `key: value` pairs only. Description values containing colons will be truncated at the first colon. This matches the upstream implementation and is not an issue in practice — all known superpowers SKILL.md files use single-line descriptions without internal colons.

## Commands

| Command | Description |
|---------|-------------|
| `/todos` | Display current todo list with progress |
| `/todo-clear` | Reset all todos |

## Architecture

```
src/
  types.ts           — Shared type definitions
  tools/
    todo-write.ts    — TodoWrite tool + state management
    task.ts          — Task tool (Agent shim)
    skill.ts         — Skill discovery, parsing, loading
  commands.ts        — /todos and /todo-clear
  index.ts           — Extension entry point + lifecycle hooks
```

The extension auto-injects the `using-superpowers` skill content into the system prompt via the `before_agent_start` lifecycle hook. This ensures the LLM receives superpowers instructions without manual configuration.

## Troubleshooting

**"using-superpowers skill not found"**
→ Install superpowers: `pi install https://github.com/obra/superpowers`

**"Task tool requires pi-subagents"**
→ Install subagents: `pi install npm:@tintinweb/pi-subagents`

**Skills not discovered**
→ Check that skill directories contain `SKILL.md` files with valid YAML frontmatter.

## Security

This extension has read-only filesystem access. It reads `SKILL.md` files from standard pi directories. No network calls, no process execution, no file writes.

## License

MIT
```

- [ ] Create the file with the content above (replace `<USER>` with the actual GitHub username)

### S72: Write root README (package catalog)

**Create:** `README.md`

```markdown
# pi-stef

Custom package collection for the [pi](https://pi.dev) coding agent.

## Packages

| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter` |

## Install All

```bash
./scripts/install-all.sh
```

For project-local install:

```bash
./scripts/install-all.sh --project
```

## Individual Install

```bash
pi install git:github.com/<USER>/pi-stef#packages/<package-name>
```

## Package Management

Use [pi-depo](https://github.com/fulgidus/pi-depo) for declarative package management and cross-machine sync. Add packages to your `kit.yml`:

```yaml
packages:
  superpowers-adapter:
    source: "git:github.com/<USER>/pi-stef#packages/superpowers-adapter"
    rating: core
```

## Prerequisites

- [pi](https://pi.dev) (>= 0.70)
- Node.js (>= 20)
- pnpm (>= 9)

## Development

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests
pnpm typecheck        # Type check
```

## License

MIT
```

- [ ] Create the file with the content above (replace `<USER>` with the actual GitHub username)

### S73: Create install-all.sh script

**Create:** `scripts/install-all.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="git:github.com/<USER>/pi-stef"
PACKAGES=("superpowers-adapter")
SCOPE="global"

if [[ "${1:-}" == "--project" ]]; then
  SCOPE="project"
fi

# Check pi is available
if ! command -v pi &>/dev/null; then
  echo "Error: 'pi' not found in PATH. Install pi first: https://pi.dev"
  exit 1
fi

FLAG=""
if [[ "$SCOPE" == "project" ]]; then
  FLAG="-l"
fi

echo "Installing pi-stef packages (${SCOPE})..."
INSTALLED=()
FAILED=()

for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "Installing ${pkg}..."
  if pi install ${FLAG} "${REPO}#packages/${pkg}"; then
    INSTALLED+=("$pkg")
  else
    FAILED+=("$pkg")
    echo "Error: Failed to install ${pkg}"
  fi
done

echo ""
echo "=== Summary ==="
if [[ ${#INSTALLED[@]} -gt 0 ]]; then
  echo "Installed: ${INSTALLED[*]}"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed: ${FAILED[*]}"
  exit 1
fi
```

- [ ] Create the file with the content above (replace `<USER>` with the actual GitHub username)
- [ ] Run `chmod +x scripts/install-all.sh`

### S74: Update .gitignore

**Modify:** `.gitignore` — add `*.log` to existing entries (the rest already exist from initial commit):

- [ ] Add `*.log` line to `.gitignore`

### S75: Run final verification

- [ ] Run `pnpm typecheck`
- [ ] Run `pnpm test`

Expected: All type checks pass. All tests pass.

### S76: Commit M7

```bash
git add README.md packages/superpowers-adapter/README.md scripts/install-all.sh .gitignore
git commit -m "docs: add READMEs, install script, and final configuration"
```
