/**
 * Integration test for the verification gate fix-loop wired into
 * `sf_team_task`. Exercises:
 *
 *   - The dev/reviewer pair completes impl-review (round 1 APPROVED).
 *   - The configured `verifyCommand` exits 1 on the FIRST call (no
 *     counter file) and exits 0 on the SECOND call (counter file
 *     present, written by the developer-revise mock as part of its
 *     "fix" for the synthetic gate-failed P0).
 *   - The reviewer mock APPROVES the gate-fix in round 2.
 *   - The gate is re-run after the dev's fix; passes; the workflow
 *     commits and reports `approved=true`.
 *   - The transcript folder contains a `system / verification-gate-failed`
 *     entry recording the synthetic finding, and round-2 developer +
 *     reviewer entries describing the fix.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamTask } from "../src/tools/task";
import { resolveDefaults } from "../src/config/load";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-gate-fix-loop-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeRun(finalText: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

describe("verification gate fix-loop wired into sf_team_task (integration)", () => {
  it("first verify-command exits 1; dev's fix writes counter; second verify-command exits 0; workflow commits and approves", async () => {
    const { root, dispose } = makeRepo();
    try {
      const counterPath = path.join(root, "verify-counter");
      const featPath = path.join(root, "feat.ts");
      // verifyCommand: exit 1 unless `verify-counter` exists. The
      // developer's revise mock will create that file as part of its
      // "fix" for the synthesized P0 finding.
      const verifyArgs = [
        "-e",
        `try { require('fs').statSync(${JSON.stringify(counterPath)}); process.exit(0); } catch { process.stderr.write('GATE_FAIL: counter missing\\n'); process.exit(1); }`,
      ];

      let devCallCount = 0;
      // reviewer outputs: APPROVED on every call (plan + impl round 1
      // + gate-fix impl round 2). We don't need any REVISE rounds; the
      // gate failure between impl-approve and the re-verification is
      // what drives the inner fix-loop into a second round.
      const reviewerOutputs = [APPROVED_TEXT, APPROVED_TEXT, APPROVED_TEXT];
      let reviewerIdx = 0;

      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "planner") {
          return fakeRun("# Plan\n\n## Goal\nadd foo\n\n## Stories\n- S-001 add foo\n");
        }
        if (member.role === "developer") {
          devCallCount += 1;
          if (devCallCount === 1) {
            // First dev call (impl-review round 1): stage a feat file.
            writeFileSync(featPath, "// impl v1\n");
            spawnSync("git", ["add", "feat.ts"], { cwd: root });
            return fakeRun("Initial implementation: added feat.ts.");
          }
          // Second dev call (gate-fix round 2): write the counter
          // file so the verify-command will exit 0 on the next run.
          // Update feat.ts with a "fix" line so the staged diff
          // changes between rounds. Stage both files.
          writeFileSync(featPath, "// impl v2 with verifier counter present\n");
          writeFileSync(counterPath, "1\n");
          spawnSync("git", ["add", "feat.ts", "verify-counter"], { cwd: root });
          return fakeRun(
            "Fix for verification gate failure: created verify-counter so the gate's exit-code check passes.",
          );
        }
        // reviewer
        const text = reviewerOutputs[Math.min(reviewerIdx, reviewerOutputs.length - 1)];
        reviewerIdx += 1;
        return fakeRun(text);
      });

      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Add Foo",
          brief: "add foo() under TDD",
          allowDirty: true,
          verifyCommand: { cmd: process.execPath, args: verifyArgs },
        },
        {
          repoRoot: root,
          configDefaults: resolveDefaults({} as never),
        },
      );

      // The workflow approved + committed because the gate-fix loop
      // turned an initial gate failure into a successful re-run.
      expect(result.approved).toBe(true);
      expect(result.commitSha).toBeTruthy();
      expect(typeof result.commitSha).toBe("string");

      // Round counters: result.rounds.impl reflects the impl-review
      // loop's own counter only (it returned roundsUsed=1 because the
      // single round-1 reviewer call APPROVED). The gate-fix loop
      // calls `implReviewerFn` again — this bumps the closure
      // `implRound` AND adds another transcript review-impl entry, but
      // it doesn't increment runReviewLoop's local counter. We assert
      // the gate-fix's effect via the developer call count + the
      // round-2 transcript entries below.
      expect(result.rounds.impl).toBe(1);

      // Developer was called twice: once for initial impl, once for
      // the gate-fix.
      expect(devCallCount).toBe(2);

      // verify-counter exists at commit time (proof the dev's fix ran
      // before the gate's second call) and feat.ts is committed.
      expect(existsSync(counterPath)).toBe(true);
      expect(existsSync(featPath)).toBe(true);

      // Transcript folder: locate the slug folder under ai_plan/.
      const slugDir = readdirSync(path.join(root, "ai_plan")).find(
        (d) => !d.startsWith("."),
      );
      expect(slugDir).toBeDefined();
      const transcriptDir = path.join(root, "ai_plan", slugDir!, "transcript");
      // Transcript should have an implementation-phase folder by now.
      expect(existsSync(transcriptDir)).toBe(true);
      // Find the verification-gate-failed entry anywhere under transcript/.
      const allTranscriptFiles: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, name.name);
          if (name.isDirectory()) walk(full);
          else allTranscriptFiles.push(full);
        }
      };
      walk(transcriptDir);
      const gateFailEntry = allTranscriptFiles.find((f) => f.includes("verification-gate-failed"));
      expect(gateFailEntry).toBeDefined();
      const body = readFileSync(gateFailEntry!, "utf8");
      // The dev-facing P0 body labels stderr UNTRUSTED and references
      // the gate failure exit code.
      expect(body).toContain("UNTRUSTED diagnostic data");
      expect(body).toContain("GATE_FAIL: counter missing");

      // Gate-fix loop transcript entries:
      //
      // - The developer's "fix" handoff records `revision-output` and
      //   `revision-impl` entries. They carry round=implRound at the
      //   moment implRevise runs — the calling tool bumps implRound
      //   INSIDE implReviewerFn (after revise), so the dev entry's
      //   round number matches the prior reviewer round (=1 here, when
      //   impl-review's round 1 just APPROVED). The PRESENCE of the
      //   revision-impl entry is the load-bearing assertion: it proves
      //   the developer was respawned for the gate fix. Without the
      //   gate-fix loop, no revision-* entry would exist (round 1 was
      //   APPROVED, no dev revise needed).
      const devReviseEntry = allTranscriptFiles.find((f) => f.includes("revision-impl"));
      expect(devReviseEntry).toBeDefined();
      // - The gate-fix's reviewer call bumps implRound BEFORE writing
      //   its transcript entry, so it lands at round=2.
      const round2ReviewerEntry = allTranscriptFiles.find((f) =>
        f.includes("review-impl") && /round-?2/.test(f),
      );
      expect(round2ReviewerEntry).toBeDefined();
    } finally {
      dispose();
    }
  }, 30_000);
});
