import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { skillDocPath } from "../src/messages";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(pkgRoot, "skills");

describe("pair skills (internal — not pi-discovered)", () => {
  // pair's skills are internal procedure docs: the sf_pair_* tools do setup
  // (worktree, reviewer model, agents) and then point the agent at the skill
  // file by PATH. To keep pi from auto-listing them as /skill:sf-pair-* (which
  // duplicated the /sf-pair-* commands and offered a broken direct entry that
  // skips the tool's setup), the package opts out of skill discovery.
  it("package.json opts out of skill discovery (pi.skills: [])", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    expect(pkg.pi?.skills).toEqual([]);
  });

  it("the 3 skill files exist and are reachable via skillDocPath (loaded by the tools, not by pi)", () => {
    const expected = ["sf-pair-implement", "sf-pair-plan", "sf-pair-task"];
    expect(readdirSync(skillsDir).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      const p = skillDocPath(name);
      expect(existsSync(p), `${name}/SKILL.md must exist at ${p}`).toBe(true);
    }
  });
});
