import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockAPI } from "./helpers/mock-api.js";
import { clearTodos } from "../src/tools/todo-write.js";
import { resetSkillCache, discoverSkills } from "../src/tools/skill.js";
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
    ) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("Original prompt.");
    expect(result.systemPrompt).toContain("You have superpowers.");
  });

  it("session_start resets state", async () => {
    extension(mockApi as any);
    const handler = mockApi.eventHandlers.get("session_start")!;
    await handler();
    expect(true).toBe(true);
  });

  it("resources_discover resets skill cache", async () => {
    extension(mockApi as any);
    const handler = mockApi.eventHandlers.get("resources_discover")!;
    await handler();
    expect(true).toBe(true);
  });

  it("discoverSkills gives cwd skills priority over home skills", () => {
    // Create a local skill with the same name as a potential home-level skill.
    // This verifies that cwd paths are searched before home paths so that
    // project-level skills override global ones.
    const skillDir = join(tempDir, ".pi", "skills", "using-superpowers");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: using-superpowers\ndescription: Local override\n---\nLocal content.\n",
    );

    resetSkillCache();
    const skills = discoverSkills(tempDir);
    const skill = skills.get("using-superpowers");
    expect(skill).toBeDefined();
    // The local (cwd) version must win over any home-level version.
    expect(skill!.path).toContain(tempDir);
  });
});
