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

  it("enforces the exhaustive-plan standard across the plan skill + planner/reviewer agents (M4)", () => {
    // Real-shipped-file regression guard (per the Value.Cast lesson: test the
    // actual shipped files, not hand-written stubs). Both the plan tool AND a
    // workflow's plan phase execute this same skill, so the standard here
    // covers both paths.
    const planSkill = readFileSync(join(skillsDir, "sf-flow-plan", "SKILL.md"), "utf8");
    const planner = readFileSync(join(pkgRoot, "agents", "planner.md"), "utf8");
    const reviewer = readFileSync(join(pkgRoot, "agents", "reviewer.md"), "utf8");

    // sf-flow-plan skill defines the standard + a completeness self-check
    expect(planSkill).toContain("Plan standard");
    expect(planSkill).toContain("completeness self-check");
    expect(planSkill).toContain("ZERO remaining design decisions");

    // planner agent mandates the exhaustive 7-field format
    expect(planner).toContain("exhaustive");
    expect(planner).toContain("ZERO remaining design decisions");
    expect(planner).toContain("completeness self-check");

    // reviewer agent treats under-detailed plans as a hard gate (REVISE),
    // independent of correctness
    expect(reviewer).toContain("under-detailed");
    expect(reviewer).toContain("ZERO remaining design decisions");
    expect(reviewer).toContain("HARD GATE");
  });

  it("tier-1 skills carry the self-resolution + agent-type-resolution instructions (M5)", () => {
    // Real-shipped-file regression: the model self-resolution preamble + the
    // agent-type resolution section must remain in every tier-1 skill so that a
    // workflow `skill:` phase (which cannot call the sf_flow_* tool) still honors
    // config.json + spawns the right agent type.
    for (const dir of ["sf-flow-plan", "sf-flow-implement", "sf-flow-audit"]) {
      const raw = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
      // model self-resolution preamble
      expect(raw, `${dir} lacks self-resolve preamble`).toContain("self-resolve");
      expect(raw, `${dir} lacks config.json reference`).toContain("config.json");
      expect(raw, `${dir} lacks inherit-orchestrator clause`).toContain("inherits the orchestrator");
      // agent-type resolution section + the Explore anti-guard
      expect(raw, `${dir} lacks Agent resolution section`).toContain("Agent resolution");
      expect(raw, `${dir} lacks general-purpose fallback`).toContain("general-purpose");
      expect(raw, `${dir} lacks Explore anti-guard`).toContain("Explore");
    }
  });
});
