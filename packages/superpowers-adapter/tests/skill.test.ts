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
