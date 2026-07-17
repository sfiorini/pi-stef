import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(pkgRoot, "skills");

const skillDirs = readdirSync(skillsDir).filter((d) =>
  existsSync(join(skillsDir, d, "SKILL.md")),
);

/** Parse the leading `---` YAML frontmatter into a key->value map (single-line values). */
function frontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

describe("flow skills", () => {
  it("every SKILL.md has frontmatter with name + description", () => {
    // Regression guard: pi's skill loader requires a `description` in the
    // frontmatter; a SKILL.md starting directly at `# title` logs
    // "description is required" and the skill won't load. Mirrors pair's format.
    expect(skillDirs.length, "expected the 6 flow skills").toBe(6);
    for (const dir of skillDirs) {
      const raw = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
      const fm = frontmatter(raw);
      expect(Object.keys(fm).length, `${dir}/SKILL.md has no frontmatter`).toBeGreaterThan(0);
      expect(fm.name, `${dir}/SKILL.md frontmatter name must match dir`).toBe(dir);
      expect(
        (fm.description ?? "").length,
        `${dir}/SKILL.md frontmatter requires a non-empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it("package.json opts out of skill discovery (pi.skills: []) — skills are internal, loaded by tools via path", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    expect(pkg.pi?.skills).toEqual([]);
  });
});
