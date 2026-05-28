import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { __testing__ } from "../src/tools/plan";
import { composePlanPatchRevisePrompt } from "../src/tools/plan-revision";
import { composePlanVerifyFixesPrompt, PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE } from "../src/tools/shared";

const PLANNER_YAML = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "skills",
  "team",
  "planner.yaml",
);

describe("planner.yaml metadata (S-106 — documentation surface)", () => {
  const yaml = readFileSync(PLANNER_YAML, "utf8");

  it("documents the lockfile-tolerant clause in the YAML", () => {
    expect(yaml).toMatch(/sf-team-locks\/\*\.lock/);
    expect(yaml).toMatch(/Do NOT refuse to draft/);
  });

  it("documents that planner runtime is read-only and skill-free", () => {
    expect(yaml).toMatch(/read-only and skill-free/i);
    expect(yaml).not.toMatch(/^skills:/m);
    expect(yaml).toMatch(/Return the full markdown plan body/i);
    expect(yaml).toMatch(/Plan written to/i);
  });

  it("documents the literal `**Stories:**` subsection (or `### Stories` heading) requirement in the YAML", () => {
    expect(yaml).toMatch(/`\*\*Stories:\*\*`/);
    expect(yaml).toMatch(/`### Stories`/);
  });
});

describe("composePlannerBrief delivers the lockfile + Stories clauses to the runtime planner (S-106)", () => {
  // Round 1 of the M1 codex review caught that the YAML system_prompt
  // is loaded by the orchestrator but NEVER passed to the pi child as
  // an --append-system-prompt argument; only the listed `skills` reach
  // the runtime. The lockfile and Stories-format clauses must therefore
  // live in the actual task brief that sf_team_plan sends to the
  // planner, which is what composePlannerBrief produces.
  const brief = __testing__.composePlannerBrief("Sample Title", "(no extra brief)");

  it("contains the lockfile-tolerant clause", () => {
    expect(brief).toMatch(/LOCKFILE NOTE/);
    expect(brief).toMatch(/sf-team-locks\/\*\.lock/);
    expect(brief).toMatch(/Do NOT refuse to draft/);
    expect(brief).toMatch(/orchestrator that spawned you holds the lock/i);
  });

  it("mandates the literal `**Stories:**` subsection (or `### Stories` heading)", () => {
    expect(brief).toMatch(/`\*\*Stories:\*\*`/);
    expect(brief).toMatch(/S-N01 — Title\./);
  });

  it("references the orchestrator's plan-shape validator", () => {
    expect(brief).toMatch(/plan-shape validator/i);
  });

  it("requires a concrete Execution Strategy with dependency and file-scope safety metadata", () => {
    expect(brief).toMatch(/## Execution Strategy/);
    expect(brief).toMatch(/execution-strategy\.json/);
    expect(brief).toMatch(/writeSets/);
    expect(brief).toMatch(/dependency/i);
    expect(brief).toMatch(/file-scope safety/i);
    expect(brief).toMatch(/"milestoneWaves"\s*:\s*\[/);
    expect(brief).toMatch(/"id"\s*:\s*"W1"/);
    expect(brief).toMatch(/"stories"\s*:\s*\{/);
    expect(brief).toMatch(/"storyWaves"\s*:\s*\[/);
  });

  it("enumerates the writeSet validator's exact accept/reject rules (no ambiguous 'globs' wording)", () => {
    // Round-3 issue from the 2026-05-22 flow-document-review-ui run: the
    // planner kept emitting Next.js dynamic-route paths like
    // `src/app/cases/[caseId]/page.tsx` because it didn't know those would
    // be rejected by the validator's regex. The prompt now MUST spell out
    // the actual rules so the planner stops guessing.
    expect(brief).toMatch(/Rejected chars:.*[`'"]?\*[`'"]?.*[`'"]?\?[`'"]?/i);
    expect(brief).toMatch(/Rejected literals:.*\ball\b.*\bunknown\b.*\btbd\b/i);
    expect(brief).toMatch(/absolute path/i);
    expect(brief).toMatch(/\.\.\s.*segment|parent.+traversal/i);
  });

  it("explicitly permits framework dynamic-route segments (Next.js / SvelteKit / Remix)", () => {
    expect(brief).toMatch(/dynamic[- ]route|\[caseId\]|\[\.\.\.slug\]/i);
    expect(brief).toMatch(/permitted|allowed|are valid/i);
  });

  it("forbids file writes by the planner", () => {
    expect(brief).toMatch(/Do NOT write/i);
    expect(brief).toMatch(/task-plan\.md/);
    expect(brief).toMatch(/milestone-plan\.md/);
  });

  it("requires the full markdown plan in the final assistant response", () => {
    expect(brief).toMatch(/full markdown plan/i);
    expect(brief).toMatch(/final assistant response/i);
    expect(brief).toMatch(/Plan written to/i);
  });
});

describe("composeReviseBrief ALSO carries the lockfile + Stories clauses (round 2 fix)", () => {
  // Round 2 of the M1 codex review caught that revisions are spawned
  // as fresh no-session pi processes and only see composeReviseBrief —
  // so without the clauses there, a reviewer-requested revision could
  // regress to refusal-prose despite the initial brief being correct.
  const reviseBrief = __testing__.composeReviseBrief();

  it("contains the lockfile-tolerant clause", () => {
    expect(reviseBrief).toMatch(/sf-team-locks\/\*\.lock/);
    expect(reviseBrief).toMatch(/Do NOT refuse to draft/);
  });

  it("re-states the Stories-format requirement", () => {
    expect(reviseBrief).toMatch(/`\*\*Stories:\*\*`/);
    expect(reviseBrief).toMatch(/S-N01 — Title\./);
  });

  it("references the orchestrator's plan-shape validator", () => {
    expect(reviseBrief).toMatch(/plan-shape validator/i);
  });

  it("also preserves the Execution Strategy contract for fresh revision processes", () => {
    expect(reviseBrief).toMatch(/## Execution Strategy/);
    expect(reviseBrief).toMatch(/writeSets/);
    expect(reviseBrief).toMatch(/dependency/i);
    expect(reviseBrief).toMatch(/file-scope safety/i);
    expect(reviseBrief).toMatch(/"milestoneWaves"\s*:\s*\[/);
    expect(reviseBrief).toMatch(/"storyWaves"\s*:\s*\[/);
  });

  it("re-states the writeSet validator rules + dynamic-route allowance on revisions too", () => {
    // Round-3 issue. Revisions go to fresh planner subprocesses and only
    // see composeReviseBrief; the rules MUST be repeated there too or the
    // planner regresses to the same bracketed-path → globless oscillation.
    expect(reviseBrief).toMatch(/Rejected chars:.*[`'"]?\*[`'"]?.*[`'"]?\?[`'"]?/i);
    expect(reviseBrief).toMatch(/Rejected literals:.*\ball\b.*\bunknown\b.*\btbd\b/i);
    expect(reviseBrief).toMatch(/dynamic[- ]route|\[caseId\]|\[\.\.\.slug\]/i);
    expect(reviseBrief).toMatch(/permitted|allowed|are valid/i);
  });

  it("also forbids file writes and summary-only final responses", () => {
    expect(reviseBrief).toMatch(/Do NOT write/i);
    expect(reviseBrief).toMatch(/full markdown plan/i);
    expect(reviseBrief).toMatch(/final assistant response/i);
    expect(reviseBrief).toMatch(/Plan written to/i);
  });
});

describe("plan reviewer runtime prompts carry execution-strategy review criteria", () => {
  it("initial sf_team_plan reviewer prompt embeds the strategy safety clauses", () => {
    const prompt = __testing__.composeInitialPlanReviewPrompt("## Execution Strategy\n```json\n{}\n```");
    expect(prompt).toContain(PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE);
    expect(prompt).toMatch(/writeSets/);
    expect(prompt).toMatch(/dependency\/file-scope safety/i);
    expect(prompt).toMatch(/P2 findings/);
    expect(prompt).toMatch(/"milestoneWaves"\s*:\s*\[/);
    expect(prompt).toMatch(/"storyWaves"\s*:\s*\[/);
  });

  it("round-2+ plan verify-fixes prompt also embeds the same strategy safety clauses", () => {
    const prompt = composePlanVerifyFixesPrompt({
      label: "plan",
      originalPlan: "original",
      priorVerdictText: "## Verdict\nVERDICT: REVISE",
      currentPlan: "current",
    });
    expect(prompt).toContain(PLAN_REVIEW_EXECUTION_STRATEGY_GUIDANCE);
    expect(prompt).toMatch(/unknown ids/);
    expect(prompt).toMatch(/cycles/);
    expect(prompt).toMatch(/writeSets/);
  });
});

describe("plan patch revision prompt carries the execution-strategy schema", () => {
  it("shows the concrete JSON shape when patching a plan", () => {
    const prompt = composePlanPatchRevisePrompt({
      label: "plan",
      priorPlan: "## Execution Strategy\n```json\n{}\n```",
      findings: { findings: { P0: [], P1: [], P2: ["Fix strategy shape"], P3: [] } },
    });
    expect(prompt).toMatch(/When patching the `## Execution Strategy` section/i);
    expect(prompt).toMatch(/"milestoneWaves"\s*:\s*\[/);
    expect(prompt).toMatch(/"id"\s*:\s*"W1"/);
    expect(prompt).toMatch(/"stories"\s*:\s*\{/);
    expect(prompt).toMatch(/"storyWaves"\s*:\s*\[/);
  });
});
