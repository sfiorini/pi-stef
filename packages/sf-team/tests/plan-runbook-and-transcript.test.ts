import { describe, expect, it } from "vitest";

import { composeContinuationRunbook, composeFinalTranscript, extractMilestones } from "../src/tools/plan";

const APPROVED_PLAN = `# Plan

## Goal
Add /healthz endpoint.

## Milestones

### M0: Bootstrap

### M1: Implement route

### M2: Tests + docs
`;

describe("extractMilestones", () => {
  it("extracts {id, title} pairs from markdown headings, sorted by numeric suffix", () => {
    const m = extractMilestones(APPROVED_PLAN);
    expect(m).toEqual([
      { id: "M0", title: "Bootstrap" },
      { id: "M1", title: "Implement route" },
      { id: "M2", title: "Tests + docs" },
    ]);
  });

  it("falls back to a single M0 placeholder when no milestones are detected", () => {
    expect(extractMilestones("just prose, no milestones")).toEqual([{ id: "M0", title: "Initial milestone" }]);
  });
});

describe("composeContinuationRunbook", () => {
  const milestones = [
    { id: "M0", title: "Bootstrap" },
    { id: "M1", title: "Implement route" },
    { id: "M2", title: "Tests" },
  ];

  it("substitutes title, slug, milestones, and round count into the template", () => {
    const out = composeContinuationRunbook({
      slug: "2026-05-01-healthz",
      title: "Add /healthz endpoint",
      milestones,
      planReviewRounds: 2,
      generatedAt: new Date("2026-05-01T17:00:00Z"),
    });
    expect(out).toContain("# Continuation Runbook: Add /healthz endpoint");
    expect(out).toContain("approved by reviewer after 2 round(s)");
    expect(out).toContain("ai_plan/2026-05-01-healthz/");
    expect(out).toContain("M0 → M1 → M2");
    expect(out).toContain("- **M0**: Bootstrap");
    expect(out).toContain("- **M1**: Implement route");
    expect(out).toContain("- **M2**: Tests");
    expect(out).toContain("After all 3 milestone(s) are completed and approved");
  });

  it("includes the 5-file reference table verbatim", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "X",
      milestones,
      planReviewRounds: 1,
    });
    expect(out).toContain("`continuation-runbook.md`");
    expect(out).toContain("`story-tracker.md`");
    expect(out).toContain("`milestone-plan.md`");
    expect(out).toContain("`original-plan.md`");
    expect(out).toContain("`final-transcript.md`");
  });

  it("single-milestone phrasing differs from multi-milestone arrow", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "X",
      milestones: [{ id: "M0", title: "the only one" }],
      planReviewRounds: 1,
    });
    expect(out).toContain("Execute the single milestone: M0");
    expect(out).not.toContain(" → ");
  });

  it("includes verification commands and tracker-discipline section", () => {
    const out = composeContinuationRunbook({ slug: "x", title: "X", milestones, planReviewRounds: 1 });
    expect(out).toContain("```bash");
    expect(out).toContain("pnpm typecheck");
    expect(out).toContain("pnpm test");
    expect(out).toMatch(/Tracker Discipline/i);
  });
});

describe("composeContinuationRunbook — codex P2 regression cases", () => {
  it("includes the Git Note section so users know ai_plan/ commits are not required", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "X",
      milestones: [{ id: "M0", title: "x" }],
      planReviewRounds: 1,
    });
    expect(out).toMatch(/## Git Note/);
    expect(out).toMatch(/`ai_plan\/` is gitignored/);
    expect(out).toMatch(/inability to commit them is NOT an error/i);
  });

  it("normalizes empty milestones[] to a single-M0 placeholder (no '0 milestone(s)' wording)", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "X",
      milestones: [],
      planReviewRounds: 1,
    });
    expect(out).not.toMatch(/all 0 milestone/i);
    expect(out).toMatch(/all 1 milestone/i);
    expect(out).toContain("- **M0**: Initial milestone");
  });

  it("sanitizes newlines/control chars in title so they don't reshape markdown", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "Multi\nline\rtitle\twith\ttabs",
      milestones: [{ id: "M0", title: "x" }],
      planReviewRounds: 1,
    });
    // First line MUST still be a single H1.
    const firstLine = out.split("\n")[0];
    expect(firstLine).toBe("# Continuation Runbook: Multi line title with tabs");
  });

  it("sanitizes pipes/newlines in milestone titles within the milestone list", () => {
    const out = composeContinuationRunbook({
      slug: "x",
      title: "X",
      milestones: [{ id: "M0", title: "API\n| CLI" }],
      planReviewRounds: 1,
    });
    expect(out).toMatch(/- \*\*M0\*\*: API \| CLI/); // collapsed to single line
    expect(out).not.toMatch(/M0\*\*: API\n/);
  });
});

describe("deriveStoryTracker pipe-safety (codex P2)", () => {
  it("encodes `|` in milestone titles as &#124; so naive split-on-pipe parsers don't corrupt the row", async () => {
    const { deriveStoryTracker } = await import("../src/tools/plan");
    const plan = "## Milestones\n\n### M0: API | CLI\n";
    const tracker = deriveStoryTracker(plan);
    // The H3 keeps the readable title.
    expect(tracker).toMatch(/### M0: API \| CLI/);
    // The table cell uses &#124; so .split("|") only splits the column delimiters.
    expect(tracker).toContain("| S-001 | API &#124; CLI | pending | |");
  });

  it("ROUNDTRIP: parseTrackerText(deriveStoryTracker(plan)) produces the SAME description (no corruption)", async () => {
    const { deriveStoryTracker } = await import("../src/tools/plan");
    const { parseTrackerText } = await import("../src/plan/tracker");
    const plan = "## Milestones\n\n### M0: API | CLI\n";
    const tracker = deriveStoryTracker(plan);
    const parsed = parseTrackerText(tracker);
    expect(parsed.milestones).toHaveLength(1);
    expect(parsed.milestones[0].id).toBe("M0");
    // Description field reconstructs the original (entity → pipe is a viewer
    // concern; the parser sees `API &#124; CLI` as one cell).
    expect(parsed.milestones[0].stories[0].description).toBe("API &#124; CLI");
  });

  it("strips newlines from titles before they hit the table", async () => {
    const { deriveStoryTracker } = await import("../src/tools/plan");
    const plan = "## Milestones\n\n- M0 - first\\nsecond\n"; // synthetic
    const tracker = deriveStoryTracker(plan);
    // No row contains a literal newline inside the table.
    const tableRows = tracker.split("\n").filter((l) => l.startsWith("| S-"));
    for (const row of tableRows) {
      expect(row).not.toContain("\n");
    }
  });
});

describe("plan-folder integration: createSfTeamPlan writes the rich runbook", () => {
  it("end-to-end: 5-file folder contains a real continuation-runbook.md (no stub)", async () => {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createSfTeamPlan } = await import("../src/tools/plan");
    const { slugify } = await import("../src/plan/slug");
    const { vi } = await import("vitest");

    const root = mkdtempSync(path.join(tmpdir(), "rb-int-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
      spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
      writeFileSync(path.join(root, "README.md"), "x");
      spawnSync("git", ["add", "."], { cwd: root });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      mkdirSync(path.join(root, "ai_plan"), { recursive: true });

      const APPROVED = `## Summary\nok\n## Findings\n### P0\n- None.\n### P1\n- None.\n### P2\n- None.\n### P3\n- None.\n## Verdict\nVERDICT: APPROVED`;
      // PLAN_BODY must satisfy the M1 plan-shape validators (length >= 200,
      // hasRealMilestones, hasRealStories) — each milestone needs a Stories
      // subsection with at least one S-N… bullet.
      const PLAN_BODY = `# Plan\n\n## Goal\nAdd /healthz endpoint.\n\n## Milestones\n\n### M0: Bootstrap\n\n**Stories:**\n- **S-001 — Bootstrap.** Set up the scaffolding.\n\n### M1: Implement\n\n**Stories:**\n- **S-101 — Implement.** Build the endpoint.\n\n### M2: Tests\n\n**Stories:**\n- **S-201 — Tests.** Add tests.\n`;
      const spawnAgent = vi.fn(async (member: { role: string }) => ({
        state: "completed",
        pid: 1,
        parentPid: process.pid,
        childPids: [],
        metrics: { startedAtMs: Date.now() },
        exitCode: 0,
        finalText: member.role === "planner" ? PLAN_BODY : APPROVED,
        events: [],
        eventsCompacted: false,
        eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
        toolCalls: [],
        stderrTail: "",
      }));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Make Healthz", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root },
      );
      const folder = path.join(root, "ai_plan", slugify("Make Healthz"));
      const runbook = readFileSync(path.join(folder, "continuation-runbook.md"), "utf8");
      const transcript = readFileSync(path.join(folder, "final-transcript.md"), "utf8");

      // Real runbook, not a 3-line stub:
      expect(runbook.length).toBeGreaterThan(500);
      expect(runbook).toContain("# Continuation Runbook: Make Healthz");
      expect(runbook).toContain("M0 → M1 → M2");
      expect(runbook).toContain("## Git Note");
      // The OLD stub line must NOT appear:
      expect(runbook).not.toContain("(see milestone-plan.md)");

      // Final transcript references the per-round audit folder:
      expect(transcript).toContain(`ai_plan/${slugify("Make Healthz")}/transcript/`);
      expect(transcript).toContain("Plan-review rounds used: **1**");
      expect(result.approved).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("composeFinalTranscript", () => {
  const milestones = [
    { id: "M0", title: "x" },
    { id: "M1", title: "y" },
  ];

  it("summarizes round count, milestone count, and points at the per-round audit folder", () => {
    const out = composeFinalTranscript({
      slug: "demo",
      title: "Demo",
      milestones,
      planReviewRounds: 3,
      generatedAt: new Date("2026-05-01T18:00:00Z"),
    });
    expect(out).toContain("# Final Transcript: Demo");
    expect(out).toContain("Plan-review rounds used: **3**");
    expect(out).toContain("Milestones detected: **2**");
    expect(out).toContain("Order: M0 → M1");
    expect(out).toContain("ai_plan/demo/transcript/");
    expect(out).toContain("NNNN-<role>-<label>");
  });

  it("does not contain the old stub stub line", () => {
    const out = composeFinalTranscript({ slug: "x", title: "X", milestones, planReviewRounds: 1 });
    expect(out).not.toMatch(/^Approved by reviewer after \d+ round\(s\)\.$/m);
  });
});
