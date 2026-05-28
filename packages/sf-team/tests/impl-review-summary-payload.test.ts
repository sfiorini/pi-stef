import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  composeImplSummary,
  composeImplVerifyFixesPrompt,
  truncateBytes,
  IMPL_FINAL_TEXT_CAP_BYTES,
  IMPL_DIFF_STAT_CAP_BYTES,
  IMPL_PRIOR_VERDICT_CAP_BYTES,
} from "../src/tools/impl-summary";
import { createSfTeamImplement } from "../src/tools/implement";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

const REVISE_TEXT = `## Summary
fix
## Findings
### P0
- something blocks
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const APPROVED_TEXT = `## Summary
ok
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: APPROVED`;

function fakeRun(text: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText: text,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

function makeRepoWithPlan(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-impl-summary-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "smoke";
  const planFolder = path.join(root, "ai_plan", slug);
  mkdirSync(planFolder, { recursive: true });
  writeFileSync(
    path.join(planFolder, "milestone-plan.md"),
    `# Plan\n\n## M0\n- S-001: bootstrap\n\n## M1\n- S-101: feature\n`,
  );
  writeFileSync(path.join(planFolder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(planFolder, "story-tracker.md"),
    `### M0: bootstrap

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | bootstrap | pending | |

**Approval Status:** pending

### M1: feature

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | feature | pending | |

**Approval Status:** pending
`,
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────────────────────
// Composer + truncation helpers
// ────────────────────────────────────────────────────────────────────────────

describe("composeImplSummary + truncateBytes", () => {
  it("(1) composeImplSummary returns finalText + a labeled stat heading + the diff stat, with a blank line between sections", () => {
    const out = composeImplSummary({
      finalText: "I implemented S-001 by adding feat.ts.",
      diffStat: " feat.ts | 5 +++++",
      label: "Files changed by this milestone",
      diffBody: "diff --git a/feat.ts b/feat.ts\n+x\n",
      transcriptHints: { implOutputName: "0001-developer-impl-output-M0.md", implDiffName: "0002-developer-impl-diff-M0.md" },
    });
    expect(out).toContain("I implemented S-001 by adding feat.ts.");
    expect(out).toContain("## Files changed by this milestone");
    expect(out).toContain(" feat.ts | 5 +++++");
    // blank line between the narrative and the stat heading
    expect(out).toMatch(/\n\n## Files changed by this milestone\n/);
  });

  it("(2) composeImplSummary truncates finalText whose Buffer.byteLength > IMPL_FINAL_TEXT_CAP_BYTES; result references the impl-output transcript", () => {
    const big = "x".repeat(IMPL_FINAL_TEXT_CAP_BYTES + 5_000); // pure ASCII so 1 byte per char
    const out = composeImplSummary({
      finalText: big,
      diffStat: " feat.ts | 1 +",
      label: "Files changed",
      diffBody: "diff --git a/feat.ts b/feat.ts\n+x\n",
      transcriptHints: { implOutputName: "0001-developer-impl-output-M0.md", implDiffName: "0002-developer-impl-diff-M0.md" },
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES + 1_000);
    expect(out).toContain("0001-developer-impl-output-M0.md");
    expect(out).toMatch(/truncated/);
  });

  it("(3) composeImplSummary truncates diffStat whose Buffer.byteLength > IMPL_DIFF_STAT_CAP_BYTES; result references the impl-diff transcript", () => {
    const bigStat = " a.ts | 1 +\n".repeat(2_000); // far over 8 KB
    const out = composeImplSummary({
      finalText: "ok",
      diffStat: bigStat,
      label: "Files changed",
      diffBody: "diff --git a/feat.ts b/feat.ts\n+x\n",
      transcriptHints: { implOutputName: "0001-developer-impl-output-M0.md", implDiffName: "0002-developer-impl-diff-M0.md" },
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES + 1_000);
    expect(out).toContain("0002-developer-impl-diff-M0.md");
  });

  it("(4) composeImplSummary substitutes a fallback note when finalText is whitespace-only", () => {
    const out = composeImplSummary({
      finalText: "  \n\n\t  \n",
      diffStat: " feat.ts | 1 +",
      label: "Files changed",
      diffBody: "diff --git a/feat.ts b/feat.ts\n+x\n",
      transcriptHints: { implOutputName: "x", implDiffName: "y" },
    });
    expect(out).toMatch(/developer produced no narrative/i);
    expect(out).toContain("## Files changed");
  });

  it("(4c) composeImplSummary embeds a 12-char diff fingerprint; identical narrative + stat with DIFFERENT diff bodies produces DIFFERENT summaries", () => {
    // Defends against the false-positive byte-equal safeguard: a refactor
    // can change file content while leaving the per-file stat identical
    // (same files touched, same line counts). Without the fingerprint,
    // two such revisions would compare byte-equal and falsely trigger
    // RevisionUnchangedError.
    const common = {
      finalText: "Refactored x.",
      diffStat: " feat.ts | 5 +++++",
      label: "Files changed",
      transcriptHints: { implOutputName: "a", implDiffName: "b" },
    };
    const a = composeImplSummary({ ...common, diffBody: "diff body version A\n" });
    const b = composeImplSummary({ ...common, diffBody: "diff body version B\n" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/<!-- diff-fingerprint: [0-9a-f]{12} -->/);
    expect(b).toMatch(/<!-- diff-fingerprint: [0-9a-f]{12} -->/);
    // Identical inputs (same diff body) MUST produce identical summaries
    // — fingerprint must be deterministic.
    const aAgain = composeImplSummary({ ...common, diffBody: "diff body version A\n" });
    expect(aAgain).toBe(a);
  });

  it("(4b) truncateBytes on a UTF-8 string whose cap falls mid-multi-byte sequence rounds DOWN to a valid UTF-8 boundary", () => {
    // "★" is 0xE2 0x98 0x85 (3 bytes). 5 stars = 15 bytes. Cap at 14 must
    // not split the 5th star — should drop it entirely.
    const stars = "★".repeat(5);
    expect(Buffer.byteLength(stars, "utf8")).toBe(15);
    const truncated = truncateBytes(stars, 14);
    // Must be valid UTF-8 (Node's Buffer roundtrip preserves valid sequences).
    const roundtrip = Buffer.from(truncated, "utf8").toString("utf8");
    expect(roundtrip).toBe(truncated);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(14);
    // 4 full stars = 12 bytes (the largest valid prefix ≤ 14).
    expect(truncated).toBe("★".repeat(4));
  });

  it("(5) composeImplVerifyFixesPrompt embeds originalImplSummary, priorVerdictText, currentFixSummary in three labeled sections; embeds a cwd hint; never embeds raw diff lines", () => {
    const prompt = composeImplVerifyFixesPrompt({
      milestoneId: "M0",
      cwd: "/tmp/worktree",
      originalImplSummary: "ORIGINAL impl summary body",
      priorVerdictText: REVISE_TEXT,
      currentFixSummary: "CURRENT fix summary body",
      transcriptHints: { priorVerdictName: "0003-reviewer-review-impl-M0-round-1-REVISE.md" },
    });
    expect(prompt).toContain("ORIGINAL impl summary body");
    expect(prompt).toContain("CURRENT fix summary body");
    expect(prompt).toContain("VERDICT: REVISE"); // the prior verdict text
    expect(prompt).toMatch(/cwd|read|grep|find|ls/i); // some kind of read-tool hint
    // No raw diff content
    expect(prompt).not.toMatch(/^diff --git /m);
    expect(prompt).not.toMatch(/^@@ -\d+/m);
  });

  it("(5b) composeImplVerifyFixesPrompt with a 50KB priorVerdictText caps it; total prompt bytes ≤ ~75 KB", () => {
    const fiftyKB = "z".repeat(50_000);
    const prompt = composeImplVerifyFixesPrompt({
      milestoneId: "M0",
      cwd: "/tmp/worktree",
      originalImplSummary: "x".repeat(IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES), // already capped above; pre-capped fixture
      priorVerdictText: fiftyKB,
      currentFixSummary: "y".repeat(IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES),
      transcriptHints: { priorVerdictName: "verdict-x.md" },
    });
    const totalBytes = Buffer.byteLength(prompt, "utf8");
    expect(totalBytes).toBeLessThanOrEqual(
      // originalImplSummary already at ~25 KB cap + currentFixSummary ~25 KB
      // + priorVerdict capped at 8 KB + structural template <= 5 KB.
      IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES // original
        + IMPL_PRIOR_VERDICT_CAP_BYTES                      // prior verdict
        + IMPL_FINAL_TEXT_CAP_BYTES + IMPL_DIFF_STAT_CAP_BYTES // current
        + 5_000,                                            // structural slack
    );
    // priorVerdictText was actually truncated (transcript pointer present).
    expect(prompt).toContain("verdict-x.md");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration: end-to-end through sf_team_implement
// ────────────────────────────────────────────────────────────────────────────

describe("sf_team_implement: summary-based reviewer payloads (E2BIG fix)", () => {
  it("(6) Round-1 reviewer payload is the composed impl summary; does NOT contain raw diff lines; does contain the developer's finalText", async () => {
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          // Dev writes a file with raw diff-looking content to ensure ANY
          // residual leak of the diff body would be detectable.
          const file = path.join(cwd, "feat.ts");
          writeFileSync(file, "// diff --git a/x b/y\n@@ -1,1 +1,1 @@\nexport const x = 1;\n");
          spawnSync("git", ["add", "feat.ts"], { cwd });
          return fakeRun("DEV-NARRATIVE: I added feat.ts implementing S-001.");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
        { repoRoot: root },
      );
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls.length).toBeGreaterThanOrEqual(1);
      const round1 = reviewerCalls[0]!.task.task;
      expect(round1).toContain("DEV-NARRATIVE: I added feat.ts implementing S-001.");
      // Diff content MUST NOT leak into the prompt.
      expect(round1).not.toMatch(/^diff --git /m);
      expect(round1).not.toMatch(/^@@ -\d+/m);
      expect(round1).not.toContain("export const x = 1;");
    } finally {
      dispose();
    }
  });

  it("(7) Round-2 reviewer payload contains originalImplSummary verbatim, prior verdict, and the round-2 fix summary; no raw diff content", async () => {
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const reviewerOutputs = [REVISE_TEXT, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const file = path.join(cwd, "feat.ts");
          writeFileSync(file, dIdx === 0 ? "// v1\n" : "// v2 fixed\n");
          spawnSync("git", ["add", "feat.ts"], { cwd });
          const narrative = dIdx === 0 ? "DEV-IMPL-V1" : "DEV-FIX-V2";
          dIdx += 1;
          return fakeRun(narrative);
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]!);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
        { repoRoot: root },
      );
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      const round2 = reviewerCalls[1]!.task.task;
      // (a) original impl summary verbatim
      expect(round2).toContain("DEV-IMPL-V1");
      // (b) prior verdict text
      expect(round2).toContain("VERDICT: REVISE");
      expect(round2).toContain("something blocks"); // P0 finding line from REVISE_TEXT
      // (c) current fix summary
      expect(round2).toContain("DEV-FIX-V2");
      // No raw diff
      expect(round2).not.toMatch(/^diff --git /m);
      expect(round2).not.toMatch(/^@@ -\d+/m);
      expect(round2).not.toContain("// v1\n");
      expect(round2).not.toContain("// v2 fixed\n");
    } finally {
      dispose();
    }
  });

  it("(8) Round-3 reviewer payload preserves the SAME originalImplSummary as round 2 (closure persistence) plus round-2 verdict + round-3 fix summary", async () => {
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Reviewer: REVISE round 1, REVISE round 2, APPROVED round 3.
      const reviewerOutputs = [
        REVISE_TEXT,
        REVISE_TEXT.replace("something blocks", "round-2 finding"),
        APPROVED_TEXT,
        APPROVED_TEXT,
      ];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const file = path.join(cwd, "feat.ts");
          writeFileSync(file, `// dev-${dIdx}\n`);
          spawnSync("git", ["add", "feat.ts"], { cwd });
          const narrative = dIdx === 0 ? "DEV-IMPL-V1" : dIdx === 1 ? "DEV-FIX-V2" : "DEV-FIX-V3";
          dIdx += 1;
          return fakeRun(narrative);
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]!);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
        { repoRoot: root },
      );
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls.length).toBeGreaterThanOrEqual(3);
      const round2 = reviewerCalls[1]!.task.task;
      const round3 = reviewerCalls[2]!.task.task;
      // Round 3 still has the ORIGINAL round-1 impl summary (DEV-IMPL-V1).
      expect(round3).toContain("DEV-IMPL-V1");
      // Round 3's prior verdict is round-2's verdict (the modified one).
      expect(round3).toContain("round-2 finding");
      expect(round3).toContain("DEV-FIX-V3");
      // Critically, round 3 must NOT contain the round-2 fix summary as the
      // "current" fix — that was the round-2 prior payload.
      expect(round3).not.toContain("DEV-FIX-V2");
      // Round 2 had DEV-FIX-V2 as the current summary; sanity check.
      expect(round2).toContain("DEV-FIX-V2");
    } finally {
      dispose();
    }
  });

  it("(9) byte-equal safeguard fires when two consecutive revisions produce byte-identical fix summaries (no actual progress)", async () => {
    // Round 1: REVISE. Round 1 revise → currentFixSummary_2 (round-2 label
    // / cumulative). Round 2 reviewer: REVISE again. Round 2 revise →
    // currentFixSummary_3 (same label, same dev narrative, same staged
    // diff → byte-equal to currentFixSummary_2). Loop refuses to advance
    // and throws RevisionUnchangedError.
    //
    // Note: the round-1 → round-2 transition cannot trigger byte-equal in
    // this design because the round-1 payload uses a different label
    // ("Files changed by milestone …") than the round-2+ payload
    // ("Current cumulative file changes …"). The safeguard only fires
    // round 2 → round 3 onward, when both compared payloads use the same
    // cumulative label.
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const reviewerOutputs = [REVISE_TEXT, REVISE_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const file = path.join(cwd, "feat.ts");
          // dIdx=0: initial impl. dIdx=1: round-1 revise (writes a different
          // file so the round-2 payload differs from round-1). dIdx=2:
          // round-2 revise produces NO change (same file, same content,
          // same narrative) → byte-equal to round-1 revise's summary.
          if (dIdx === 0) writeFileSync(file, "// initial\n");
          else if (dIdx === 1) writeFileSync(file, "// revise-1\n");
          else writeFileSync(file, "// revise-1\n"); // identical to dIdx=1
          spawnSync("git", ["add", "feat.ts"], { cwd });
          const narrative = dIdx === 0 ? "DEV-INITIAL" : "DEV-REVISE-FIXED-AGAIN";
          dIdx += 1;
          return fakeRun(narrative);
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]!);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(
        tool(
          { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
          { repoRoot: root },
        ),
      ).rejects.toThrow(/byte-equal/i);
    } finally {
      dispose();
    }
  });

  it("(10) reviewer spawn for impl-review is invoked with cwd: ctx.cwd (the worktree path)", async () => {
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const reviewerCallCwds: (string | undefined)[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "reviewer") {
          reviewerCallCwds.push(task.cwd);
          return fakeRun(APPROVED_TEXT);
        }
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, "feat.ts"), "// x\n");
          spawnSync("git", ["add", "feat.ts"], { cwd });
        }
        return fakeRun("DEV-NARRATIVE");
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
        { repoRoot: root },
      );
      expect(reviewerCallCwds.length).toBeGreaterThanOrEqual(1);
      // ctx.cwd === root in this test (useWorktree: false).
      for (const cwd of reviewerCallCwds) expect(cwd).toBe(root);
    } finally {
      dispose();
    }
  });

  it("(11) transcript file <NNNN>-developer-impl-diff-M<X>.md still contains the FULL git diff body — no truncation regression", async () => {
    const { root, slug, dispose } = makeRepoWithPlan();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          // Write enough content that the diff body is non-trivial.
          writeFileSync(
            path.join(cwd, "feat.ts"),
            "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n",
          );
          spawnSync("git", ["add", "feat.ts"], { cwd });
          return fakeRun("DEV");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue: () => false },
        { repoRoot: root },
      );
      const transcriptDir = path.join(root, "ai_plan", slug, "transcript", "implementation");
      const files = require("node:fs").readdirSync(transcriptDir) as string[];
      const diffFile = files.find((f) => /developer-impl-diff-M\d+\.md/.test(f));
      expect(diffFile).toBeDefined();
      const diffBody = readFileSync(path.join(transcriptDir, diffFile!), "utf8");
      // The full diff body MUST appear in the transcript even though it never
      // leaves the orchestrator for the reviewer prompt.
      expect(diffBody).toMatch(/^diff --git /m);
      expect(diffBody).toMatch(/export const x = 1;/m);
      expect(diffBody).toMatch(/export const z = 3;/m);
    } finally {
      dispose();
    }
  });
});
