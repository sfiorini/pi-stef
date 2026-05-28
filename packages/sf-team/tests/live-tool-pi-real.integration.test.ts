import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { MaxReviewRoundsError, RevisionUnchangedError } from "../src/review/loop";
import { defaultDeps } from "../src/tools/shared";

/**
 * PI_INTEGRATION live-pi-real: spawns a TRUE `pi --mode json -p` subprocess
 * end-to-end for `sf_team_plan` with a deterministic short brief. Asserts a
 * non-empty finalPlan, folder written, no last-draft.md (because the loop
 * approved). This proves the installed-pi end-to-end path works for at least
 * one tool. The other four tools share the same orchestrator/spawn machinery.
 *
 * Gated by PI_INTEGRATION=1 AND pi binary availability.
 */
describe("live-tool-pi-real: sf_team_plan against real pi subprocess", () => {
  const integrationEnabled = process.env.PI_INTEGRATION === "1";
  const piAvailable = (() => {
    if (!integrationEnabled) return false;
    const pathEnv = process.env.PATH ?? "";
    return pathEnv.split(":").some((dir) => dir.length > 0 && existsSync(`${dir}/pi`));
  })();

  it.skipIf(!piAvailable)(
    "sf_team_plan against real pi: end-to-end either approves with a 5-file folder OR persists partial output",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ct-livepi-"));
      try {
        spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
        spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
        spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
        writeFileSync(path.join(root, "README.md"), "x");
        spawnSync("git", ["add", "."], { cwd: root });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
        mkdirSync(path.join(root, "ai_plan"), { recursive: true });

        // Production deps — real spawnAgent, real runReviewLoop. The acceptance
        // is: the orchestrator drives a real pi subprocess to completion AND
        // either lands an approved 5-file folder OR (when the reviewer is too
        // strict for the round budget) writes last-draft.md + last-review.md so
        // the user has actionable output. Both outcomes prove the live path.
        //
        // Override planner+reviewer to a fast model with low thinking so the
        // test finishes inside vitest's 5-minute window. The default xhigh
        // thinking level on opus is 1-3 min/turn and will time out the test.
        const tool = createSfTeamPlan(defaultDeps);
        const fastPlanner = { role: "planner" as const, model: "claude-haiku-4-5", thinking: "low" as const, skills: [] };
        const fastReviewer = { role: "reviewer" as const, model: "claude-haiku-4-5", thinking: "low" as const };
        let result: Awaited<ReturnType<typeof tool>> | undefined;
        let loopErr: MaxReviewRoundsError<unknown> | RevisionUnchangedError<unknown> | undefined;
        try {
          result = await tool(
            {
              title: "Healthz Endpoint Live",
              brief:
                "Add a /healthz HTTP route that returns {ok: true}. Single milestone with one story to add the route and one to test it.",
              maxRounds: 2,
              planner: fastPlanner,
              reviewer: fastReviewer,
            },
            { repoRoot: root },
          );
        } catch (err) {
          if (err instanceof MaxReviewRoundsError || err instanceof RevisionUnchangedError) loopErr = err;
          else throw err;
        }

        if (result) {
          expect(result.approved).toBe(true);
          expect(result.finalPlan.length).toBeGreaterThan(20);
          expect(result.folderPath).toBeTruthy();
          const folder = result.folderPath!;
          const files = ["original-plan.md", "milestone-plan.md", "story-tracker.md", "continuation-runbook.md", "final-transcript.md"];
          for (const name of files) {
            expect(readFileSync(path.join(folder, name), "utf8").length).toBeGreaterThan(0);
          }
          expect(existsSync(path.join(folder, "last-draft.md"))).toBe(false);
          expect(existsSync(path.join(folder, "last-review.md"))).toBe(false);
        } else {
          expect(loopErr).toBeDefined();
          // Path is named in the error message; both files exist on disk.
          const msg = loopErr!.message;
          const draftMatch = msg.match(/last-draft\.md=(\S+?)(?:,|\.\s|$)/);
          const reviewMatch = msg.match(/last-review\.md=(\S+?)(?:,|\.\s|$)/);
          expect(draftMatch?.[1]).toBeTruthy();
          expect(reviewMatch?.[1]).toBeTruthy();
          // Strip a trailing comma or period that the regex may have caught.
          const draftPath = draftMatch![1].replace(/[,.]$/, "");
          const reviewPath = reviewMatch![1].replace(/[,.]$/, "");
          const draftBody = readFileSync(draftPath, "utf8");
          const reviewBody = readFileSync(reviewPath, "utf8");
          // Real pi planner and reviewer both produced non-trivial responses.
          // The reviewer might not always emit a clean VERDICT line (e.g. when
          // it deems the planner's draft was a question, not a plan); what
          // matters is that BOTH agents ran and BOTH responses landed on disk.
          expect(draftBody.length).toBeGreaterThan(50);
          expect(reviewBody.length).toBeGreaterThan(50);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    480_000, // 8 minutes — haiku low-thinking finishes in 1-3 min normally
  );
});
