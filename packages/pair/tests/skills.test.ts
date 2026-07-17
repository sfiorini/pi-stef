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
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

describe("pair skills", () => {
  it("every skill is hidden from model invocation (no duplicate with the /sf-pair-* commands)", () => {
    // pair registers slash commands /sf-pair-{plan,implement,task} (register.ts)
    // that route to the sf_pair_* tools, which load these skills internally.
    // Without disable-model-invocation, pi also lists each as a /skill:sf-pair-*
    // command -> a duplicate entry, and the model could auto-load the skill
    // directly, skipping the tool's setup (model resolution, worktree, ...).
    // flow is intentionally EXCLUDED: it has no /sf-flow-* commands, so its
    // skills are the user's only slash entry and must stay visible.
    expect(skillDirs.length).toBe(3);
    for (const dir of skillDirs) {
      const raw = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
      const fm = frontmatter(raw);
      expect(fm.name, `${dir}/SKILL.md name must match dir`).toBe(dir);
      expect(
        fm["disable-model-invocation"],
        `${dir}/SKILL.md must set disable-model-invocation: true (pair has /sf-pair-* command aliases)`,
      ).toBe("true");
    }
  });
});
