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

  it("sf-flow-auto + sf-flow-plan instruct AI-generated max-4-word slugs (Site 1 + tier-1)", () => {
    // Both pin the run/plan slug to <YYYY-MM-DD>-<max 4 words> (AI-generated),
    // replacing the old deterministic 60-char kebab. Guards the doc ACs.
    const auto = readFileSync(join(skillsDir, "sf-flow-auto", "SKILL.md"), "utf8");
    const plan = readFileSync(join(skillsDir, "sf-flow-plan", "SKILL.md"), "utf8");
    expect(auto).toContain("max 4 words");
    expect(auto).toMatch(/pass it as the[^;]*slug[^;]*parameter/i);
    expect(plan).toContain("max 4 words");
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

  it("sf-flow-implement delegates to the developer per milestone; orchestrator writes no code (M6)", () => {
    const raw = readFileSync(join(skillsDir, "sf-flow-implement", "SKILL.md"), "utf8");
    expect(raw).toContain("developer");
    expect(raw).toContain("write NO code");
    expect(raw).toContain("delegate");
    // the missing-developer fallback must not have the orchestrator implement itself
    expect(raw).toContain("general-purpose");
    expect(raw).toContain("NEVER falls back to implementing");
  });

  it("encodes the delta-review protocol across the 3 skills + reviewer/auditor/planner/developer (delta-review)", () => {
    const plan = readFileSync(join(skillsDir, "sf-flow-plan", "SKILL.md"), "utf8");
    const impl = readFileSync(join(skillsDir, "sf-flow-implement", "SKILL.md"), "utf8");
    const audit = readFileSync(join(skillsDir, "sf-flow-audit", "SKILL.md"), "utf8");
    const reviewer = readFileSync(join(pkgRoot, "agents", "reviewer.md"), "utf8");
    const auditor = readFileSync(join(pkgRoot, "agents", "auditor.md"), "utf8");
    const planner = readFileSync(join(pkgRoot, "agents", "planner.md"), "utf8");
    const developer = readFileSync(join(pkgRoot, "agents", "developer.md"), "utf8");

    for (const [name, raw] of [["sf-flow-plan", plan], ["sf-flow-implement", impl], ["sf-flow-audit", audit]] as const) {
      expect(raw, `${name} mentions delta-review`).toContain("delta-review");
      expect(raw, `${name} mentions verification mode`).toContain("verification mode");
      expect(raw, `${name} mentions canonical`).toContain("canonical");
    }

    expect(plan).toContain("Max **10 rounds**");
    expect(impl).toContain("Max **5 rounds**");
    expect(audit).toContain("Max **5 rounds**");

    for (const [name, raw] of [["reviewer", reviewer], ["auditor", auditor]] as const) {
      expect(raw, `${name} defines FIXED`).toContain("FIXED");
      expect(raw, `${name} defines PARTIALLY-FIXED`).toContain("PARTIALLY-FIXED");
      expect(raw, `${name} defines NOT-FIXED`).toContain("NOT-FIXED");
      expect(raw, `${name} defines NEW-ISSUE-INTRODUCED`).toContain("NEW-ISSUE-INTRODUCED");
    }

    expect(planner).toContain("re-spawned");
    expect(developer).toContain("re-spawned");

    // regression guard: pre-existing M4/M6 substrings still present
    expect(plan).toContain("Plan standard");
    expect(plan).toContain("ZERO remaining design decisions");
    expect(reviewer).toContain("HARD GATE");
    expect(reviewer).toContain("under-detailed");
    expect(planner).toContain("completeness self-check");
    expect(impl).toContain("write NO code");
    expect(impl).toContain("NEVER falls back to implementing");
  });

  it("tier-1 skills document the PATH-prepend for notify-telegram.sh resolution", () => {
    for (const dir of ["sf-flow-plan", "sf-flow-implement", "sf-flow-audit"]) {
      const raw = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
      expect(raw, `${dir} lacks the .bin PATH-prepend`).toContain("$HOME/.pi/agent/npm/node_modules/.bin");
      expect(raw, `${dir} lacks the export PATH= form`).toMatch(/export\s+PATH=.*\.bin/);
    }
  });
});
