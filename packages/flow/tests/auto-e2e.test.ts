import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSlug, materializeArtifacts, assertArtifacts } from "../src/contract/ops.js";
import { WorkflowState, prepareRunState, loadState } from "../src/workflow/state.js";

/**
 * End-to-end contract dataflow for a ship-feature-shaped run (M9). Rather than spin
 * up the pi-dw runtime, this drives the REAL helper functions in the exact sequence
 * the generated script emits (pre-seed → plan: derive/materialize/assert/complete →
 * implement: load-required/assert/complete → terminal load-all), with stubbed agent
 * outputs. This validates the self-defeating enforcement, resume, and block paths.
 */
describe("auto-e2e: ship-feature contract dataflow (M9)", () => {
  const PHASE_IDS = ["plan", "implement", "notify"];
  const ARTIFACTS = [
    { file: "original-plan.md", template: "@flow/plan/original-plan.md" },
    { file: "milestone-plan.md", template: "@flow/plan/milestone-plan.md" },
    { file: "story-tracker.md", template: "@flow/plan/story-tracker.md" },
    { file: "continuation-runbook.md", template: "@flow/plan/continuation-runbook.md" },
  ];
  const seed = (slug: string) => ({
    workflowName: "ship-feature",
    workflowHash: "wh-ship",
    inputHash: "ih-feature",
    slug,
    phaseIds: PHASE_IDS,
  });

  function freshRun(slug: string): string {
    const repo = mkdtempSync(join(tmpdir(), "flow-e2e-"));
    const planDir = join(repo, "ai_plan", slug);
    prepareRunState(planDir, seed(slug));
    return planDir;
  }

  it("a plan→implement run leaves 4 non-empty artifacts and marks plan success", () => {
    const slug = deriveSlug("Add a login rate limit", { prefix: "date", now: new Date("2026-08-03T00:00:00Z") });
    expect(slug).toBe("2026-08-03-add-a-login-rate-limit");
    const planDir = freshRun(slug);

    // plan phase prologue: materialize skeletons, then the (stubbed) planner fills them
    materializeArtifacts(planDir, ARTIFACTS);
    for (const a of ARTIFACTS) writeFileSync(join(planDir, a.file), `# ${a.file}\nreal plan content\n`);
    // epilogue: assert nonempty (engine check) + atomic complete
    expect(assertArtifacts(planDir, ["nonempty"], ARTIFACTS.map((a) => a.file)).status).toBe("success");
    new WorkflowState(planDir, seed(slug)).complete(
      "plan",
      { slug, plan_dir: planDir, plan_doc: "real plan content" },
      ARTIFACTS.map((a) => a.file),
    );

    for (const a of ARTIFACTS) {
      expect(readFileSync(join(planDir, a.file), "utf8").length).toBeGreaterThan(0);
    }
    const loaded = loadState(planDir)!;
    expect(loaded.phases.find((p) => p.id === "plan")!.status).toBe("success");
    expect(loaded.phases.find((p) => p.id === "plan")!.outputs).toMatchObject({ slug, plan_doc: "real plan content" });
    expect(loaded.phases.find((p) => p.id === "implement")!.status).toBe("pending");
  });

  it("the next phase's load-required resolves the plan's publishes; a missing one blocks", () => {
    const slug = "e2e-handoff";
    const planDir = freshRun(slug);
    materializeArtifacts(planDir, ARTIFACTS);
    new WorkflowState(planDir, seed(slug)).complete("plan", { slug, plan_dir: planDir, plan_doc: "P" }, ARTIFACTS.map((a) => a.file));

    // implement prologue: load-required [slug, plan_doc]
    const st = new WorkflowState(planDir, seed(slug));
    const ok = st.loadRequired(["slug", "plan_doc"]);
    expect(ok.status).toBe("success");
    expect(ok.values).toMatchObject({ slug, plan_doc: "P" });
    // a name nobody published -> blocked (self-defeating dataflow)
    const blocked = st.loadRequired(["nope"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.missing).toEqual(["nope"]);
  });

  it("resume after an interruption restarts at the first non-success phase", () => {
    const slug = "e2e-resume";
    const planDir = freshRun(slug);
    materializeArtifacts(planDir, ARTIFACTS);
    new WorkflowState(planDir, seed(slug)).complete("plan", { slug, plan_dir: planDir, plan_doc: "P" }, ARTIFACTS.map((a) => a.file));
    // simulate an interruption: implement never ran. A fresh reload (resume) finds implement.
    const resumed = new WorkflowState(planDir, seed(slug));
    expect(resumed.firstIncomplete()).toBe(PHASE_IDS.indexOf("implement"));
  });

  it("deleting an artifact makes the assert step block the phase", () => {
    const slug = "e2e-block";
    const planDir = freshRun(slug);
    materializeArtifacts(planDir, ARTIFACTS);
    for (const a of ARTIFACTS) writeFileSync(join(planDir, a.file), "content");
    expect(assertArtifacts(planDir, ["nonempty"], ARTIFACTS.map((a) => a.file)).status).toBe("success");
    rmSync(join(planDir, "milestone-plan.md"));
    const r = assertArtifacts(planDir, ["nonempty"], ARTIFACTS.map((a) => a.file));
    expect(r.status).toBe("blocked");
    expect(r.missing).toContain("milestone-plan.md");
  });

  it("implement's tracker_updated assert blocks until the tracker advances past pending", () => {
    const slug = "e2e-tracker";
    const planDir = freshRun(slug);
    // tracker scaffold (all pending) -> tracker_updated blocks
    writeFileSync(join(planDir, "story-tracker.md"), "| S-M1-1 | M1 | pending | — | — |\n");
    expect(assertArtifacts(planDir, ["tracker_updated"]).status).toBe("blocked");
    // developer advanced a story -> tracker_updated passes
    writeFileSync(join(planDir, "story-tracker.md"), "| S-M1-1 | M1 | implemented | abc123 | — |\n");
    expect(assertArtifacts(planDir, ["tracker_updated"]).status).toBe("success");
  });

  it("the terminal load-all reports success when every phase completed, with the artifacts", () => {
    const slug = "e2e-terminal";
    const planDir = freshRun(slug);
    materializeArtifacts(planDir, ARTIFACTS);
    const st = new WorkflowState(planDir, seed(slug));
    st.complete("plan", { slug, plan_dir: planDir }, ARTIFACTS.map((a) => a.file));
    st.complete("implement", { impl_result: "ok" }, []);
    st.complete("notify", { notify_result: "sent" }, []);
    // load-all view (what the structured terminal reads)
    const view = new WorkflowState(planDir, seed(slug));
    expect(view.firstIncomplete()).toBe(-1);
    const all = loadState(planDir)!;
    const artifacts = all.phases.flatMap((p) => p.artifacts);
    expect(artifacts).toHaveLength(ARTIFACTS.length);
  });
});
