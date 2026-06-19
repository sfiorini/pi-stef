import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { SkillMeta } from "../types.js";

const SkillSchema = Type.Object({
  skill: Type.String({
    description:
      "Name of the skill to load (e.g., 'brainstorming', 'test-driven-development')",
  }),
});

type SkillInput = Static<typeof SkillSchema>;

let skillCache: Map<string, SkillMeta> | null = null;

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n?---\n([\s\S]*)$/;

export function resetSkillCache(): void {
  skillCache = null;
}

export function parseSkillFrontmatter(
  content: string,
  path: string,
): SkillMeta | null {
  const match = content.match(FRONTMATTER_RE);
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
  const match = content.match(FRONTMATTER_RE);
  return match ? match[2].trim() : content;
}

export function readSkillContent(skillPath: string): string | null {
  try {
    const content = readFileSync(skillPath, "utf-8");
    return extractSkillContent(content);
  } catch (err) {
    return `[pi-superpowers-adapter] Failed to read skill file "${skillPath}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

function findSkillsDirs(
  basePath: string,
  results: string[],
  depth = 0,
): void {
  const MAX_DEPTH = 10;
  const MAX_BREADTH = 200;
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(basePath, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `[pi-superpowers-adapter] Failed to read directory "${basePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let visited = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (++visited > MAX_BREADTH) break;
    const fullPath = join(basePath, entry.name);
    if (entry.name === "skills") {
      results.push(fullPath);
    } else {
      findSkillsDirs(fullPath, results, depth + 1);
    }
  }
}

/**
 * Collect `skills/` directories from a node_modules layout.
 * Handles scoped (@scope/pkg) and unscoped (pkg) packages.
 */
function collectNodeModulesSkillPaths(
  nodeModulesDir: string,
  skillPaths: string[],
): void {
  if (!existsSync(nodeModulesDir)) return;
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      // Scope directory: iterate packages one level deeper.
      const scopeDir = join(nodeModulesDir, entry.name);
      let scopedEntries;
      try {
        scopedEntries = readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of scopedEntries) {
        if (!pkg.isDirectory()) continue;
        const pkgSkillsDir = join(scopeDir, pkg.name, "skills");
        if (existsSync(pkgSkillsDir)) {
          skillPaths.push(pkgSkillsDir);
        }
      }
    } else {
      // Unscoped package directory.
      const pkgSkillsDir = join(nodeModulesDir, entry.name, "skills");
      if (existsSync(pkgSkillsDir)) {
        skillPaths.push(pkgSkillsDir);
      }
    }
  }
}

export function discoverSkills(cwd: string, homeDir?: string): Map<string, SkillMeta> {
  if (skillCache) return skillCache;

  const skills = new Map<string, SkillMeta>();
  const home = homeDir ?? homedir();

  const skillPaths = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(home, ".pi", "agent", "skills"),
    join(home, ".agents", "skills"),
  ];

  // Add workspace package skills (monorepo pattern)
  const packagesDir = join(cwd, "packages");
  if (existsSync(packagesDir)) {
    try {
      const packages = readdirSync(packagesDir, { withFileTypes: true });
      for (const pkg of packages) {
        if (pkg.isDirectory()) {
          const pkgSkillsDir = join(packagesDir, pkg.name, "skills");
          if (existsSync(pkgSkillsDir)) {
            skillPaths.push(pkgSkillsDir);
          }
        }
      }
    } catch {
      // Skip if can't read packages directory
    }
  }

  // Add locally installed package skills (node_modules pattern), any scope.
  collectNodeModulesSkillPaths(join(cwd, "node_modules"), skillPaths);

  // Add globally installed package skills (~/.pi/agent/npm/node_modules pattern).
  // This is where `pi install`/catalog packages live on consumer machines.
  collectNodeModulesSkillPaths(
    join(home, ".pi", "agent", "npm", "node_modules"),
    skillPaths,
  );

  const gitPackagesDir = join(home, ".pi", "agent", "git");
  if (existsSync(gitPackagesDir)) {
    findSkillsDirs(gitPackagesDir, skillPaths);
  }

  for (const basePath of skillPaths) {
    if (!existsSync(basePath)) continue;
    try {
      const entries = readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(basePath, entry.name);
        // Check if this entry is a skill directory (has SKILL.md) or a container (has subdirs)
        const skillFile = join(entryPath, "SKILL.md");
        if (existsSync(skillFile)) {
          // Entry is a skill directory
          try {
            const content = readFileSync(skillFile, "utf-8");
            const meta = parseSkillFrontmatter(content, skillFile);
            if (meta?.name && !skills.has(meta.name)) {
              skills.set(meta.name, meta);
            }
          } catch {
            // Skip unreadable skill files
          }
        } else {
          // Entry might be a container directory of skills (e.g., a symlink to a skills collection)
          // Try to discover skills one level deeper
          try {
            const subEntries = readdirSync(entryPath, { withFileTypes: true });
            for (const subEntry of subEntries) {
              const subSkillFile = join(entryPath, subEntry.name, "SKILL.md");
              if (!existsSync(subSkillFile)) continue;
              try {
                const content = readFileSync(subSkillFile, "utf-8");
                const meta = parseSkillFrontmatter(content, subSkillFile);
                if (meta?.name && !skills.has(meta.name)) {
                  skills.set(meta.name, meta);
                }
              } catch {
                // Skip unreadable skill files
              }
            }
          } catch {
            // Not a directory or unreadable, skip
          }
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
      if (!skillContent || skillContent.startsWith("[pi-superpowers-adapter]")) {
        return {
          content: [
            {
              type: "text" as const,
              text: skillContent ?? `[pi-superpowers-adapter] Error loading skill "${params.skill}": Failed to read skill file`,
            },
          ],
          isError: true,
          details: { error: skillContent ?? "Failed to read skill file", skillPath: skill.path },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded skill: ${skill.name}\n${skill.description ? `\nDescription: ${skill.description}\n` : ""}\n\n${skillContent}`,
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
      result: { content: { type: string; text?: string }[]; details?: Record<string, unknown> },
      _options: unknown,
      theme: Theme,
      context: { isError?: boolean },
    ) {
      if (context.isError) {
        const errorMsg =
          result.content[0]?.type === "text" && result.content[0].text
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
