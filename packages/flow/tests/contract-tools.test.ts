import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSlug, materializeArtifacts, assertArtifacts, writeRunPrompt } from "../src/contract/ops.js";
import { WorkflowState, loadState, statePath, prepareRunState } from "../src/workflow/state.js";

describe("deriveSlug", () => {
  it("kebabs input and prefixes a date", () => {
    const s = deriveSlug("Add a Rate Limiter!!", { prefix: "date", now: new Date("2026-08-03T00:00:00Z") });
    expect(s).toBe("2026-08-03-add-a-rate-limiter");
  });
  it("no prefix", () => {
    expect(deriveSlug("Add a Rate Limiter", { prefix: "none" })).toBe("add-a-rate-limiter");
  });
  it("defaults to a date prefix", () => {
    const s = deriveSlug("Ship It", { now: new Date("2026-08-03T00:00:00Z") });
    expect(s).toBe("2026-08-03-ship-it");
  });
  it("collapses to a stable slug for empty/garbage input", () => {
    expect(deriveSlug("!!!", { prefix: "none" })).toBe("flow");
  });

  it("caps a long prompt at ~60 chars on a word boundary (no trailing hyphen)", () => {
    const long =
      "This is an extremely long prompt that definitely exceeds sixty characters and then keeps going with more words";
    const s = deriveSlug(long, { prefix: "none" });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).not.toMatch(/-$/);
    expect(s.startsWith("this-is-an-extremely")).toBe(true);
  });

  it("hard-caps a single word longer than the limit (never empty)", () => {
    const s = deriveSlug("a".repeat(120), { prefix: "none" });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("writeRunPrompt", () => {
  it("writes the original input to <dir>/prompt.md and returns the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const p = writeRunPrompt(dir, "Add a login rate limiter");
    expect(p).toBe(join(dir, "prompt.md"));
    expect(readFileSync(p, "utf8")).toBe("Add a login rate limiter");
  });

  it("creates the dir if missing (run-start before any other artifact)", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "flow-")), "nested", "ai_plan", "slug");
    const p = writeRunPrompt(dir, "x");
    expect(readFileSync(p, "utf8")).toBe("x");
  });
});

describe("materializeArtifacts", () => {
  it("writes template skeletons and is resume-safe (never clobbers non-empty)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "milestone-plan.md"), "EXISTING NON-EMPTY");
    materializeArtifacts(dir, [
      { file: "milestone-plan.md", template: "@flow/plan/milestone-plan.md" },
      { file: "story-tracker.md", template: "@flow/plan/story-tracker.md" },
    ]);
    expect(readFileSync(join(dir, "milestone-plan.md"), "utf8")).toBe("EXISTING NON-EMPTY"); // not clobbered
    expect(readFileSync(join(dir, "story-tracker.md"), "utf8").length).toBeGreaterThan(0);
  });

  it("creates the target dir if missing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "flow-")), "nested", "out");
    materializeArtifacts(dir, [{ file: "x.md", template: "@flow/plan/original-plan.md" }]);
    expect(readFileSync(join(dir, "x.md"), "utf8").length).toBeGreaterThan(0);
  });

  it("writes an empty file when no template is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    materializeArtifacts(dir, [{ file: "blank.md" }]);
    expect(readFileSync(join(dir, "blank.md"), "utf8")).toBe("");
  });
});

describe("assertArtifacts", () => {
  it("blocks on missing dir", () => {
    const r = assertArtifacts(join(tmpdir(), "definitely-missing-" + Math.random().toString(36)), ["nonempty"]);
    expect(r.status).toBe("blocked");
  });
  it("blocks when an artifact file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "empty.md"), "");
    const r = assertArtifacts(dir, ["nonempty"]);
    expect(r.status).toBe("blocked");
    expect(r.empty).toContain("empty.md");
  });
  it("blocks when the dir has no artifacts at all (nonempty asserted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const r = assertArtifacts(dir, ["nonempty"]);
    expect(r.status).toBe("blocked");
  });
  it("succeeds when all .md files are non-empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "a.md"), "content");
    writeFileSync(join(dir, "b.md"), "content");
    const r = assertArtifacts(dir, ["nonempty"]);
    expect(r.status).toBe("success");
  });
  it("checks an explicit file list when provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "a.md"), "x");
    const r = assertArtifacts(dir, [], ["a.md", "b.md"]);
    expect(r.status).toBe("blocked");
    expect(r.missing).toContain("b.md");
  });
});

describe("WorkflowState", () => {
  const seed = (dir: string, phaseIds = ["plan", "implement", "finalize"]) => ({
    workflowName: "ship-feature",
    workflowHash: "h" + dir.length,
    inputHash: "ih",
    slug: "s",
    phaseIds,
  });

  it("publish then loadRequired resolves; missing -> blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const st = new WorkflowState(dir, seed(dir));
    st.publish("plan", { slug: "s", plan_dir: dir }, ["a.md"]);
    expect(st.loadRequired(["slug"]).status).toBe("success");
    expect(st.loadRequired(["nope"]).status).toBe("blocked");
    expect(st.loadRequired(["nope"]).missing).toEqual(["nope"]);
  });

  it("complete() is atomic: a fresh WorkflowState sees the publish (no publish->write race)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s = seed(dir);
    const st = new WorkflowState(dir, s);
    st.complete("plan", { slug: "the-slug", plan_dir: dir }, ["milestone-plan.md"]);
    // a SEPARATE state reloads from disk — must still see the published slug
    const fresh = new WorkflowState(dir, s);
    const req = fresh.loadRequired(["slug"]);
    expect(req.status).toBe("success");
    expect(req.values.slug).toBe("the-slug");
    expect(fresh.firstIncomplete()).toBe(1); // implement still pending
  });

  it("write() is atomic and reloads; resume finds the first incomplete phase", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s = seed(dir);
    const st = new WorkflowState(dir, s);
    st.mark("plan", "success");
    st.write();
    const resumed = new WorkflowState(dir, s); // reloads from disk
    expect(resumed.firstIncomplete()).toBe(1); // implement still pending -> resume target
  });

  it("firstIncomplete returns -1 once every phase is success", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s = seed(dir);
    const st = new WorkflowState(dir, s);
    for (const id of s.phaseIds) st.complete(id, {}, []);
    expect(st.firstIncomplete()).toBe(-1);
  });

  it("does NOT persist phaseIds into the checkpoint JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const st = new WorkflowState(dir, seed(dir));
    st.write();
    const raw = readFileSync(statePath(dir), "utf8");
    expect(raw).not.toMatch(/phaseIds/);
  });

  it("forwards new phases added to the workflow since the last run", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s1 = seed(dir, ["plan", "implement"]);
    const first = new WorkflowState(dir, s1);
    first.complete("plan", {}, []);
    // workflow grows a finalize phase
    const s2 = seed(dir, ["plan", "implement", "finalize"]);
    const second = new WorkflowState(dir, s2);
    expect(second.data.phases.map((p) => p.id)).toEqual(["plan", "implement", "finalize"]);
    expect(second.firstIncomplete()).toBe(1); // plan success, implement still pending
  });

  it("loadState returns null when no checkpoint exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    expect(loadState(dir)).toBeNull();
  });
});

describe("prepareRunState (sf_flow_auto pre-seed + resume)", () => {
  const seed = (dir: string, phaseIds = ["plan", "implement"]) => ({
    workflowName: "ship-feature",
    workflowHash: "wh-" + dir.length,
    inputHash: "ih-1",
    slug: "s",
    phaseIds,
  });

  it("seeds a fresh all-pending state when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const r = prepareRunState(dir, seed(dir));
    expect(r.resumed).toBe(false);
    const st = loadState(dir)!;
    expect(st.phases.map((p) => p.id)).toEqual(["plan", "implement"]);
    expect(st.phases.every((p) => p.status === "pending")).toBe(true);
  });

  it("resumes (keeps progress) when workflow+input hashes match", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s = seed(dir);
    prepareRunState(dir, s); // seed
    new WorkflowState(dir, s).complete("plan", { slug: "kept" }, []); // make progress
    const r = prepareRunState(dir, s); // same hashes -> resume
    expect(r.resumed).toBe(true);
    expect(loadState(dir)!.phases.find((p) => p.id === "plan")!.status).toBe("success"); // progress kept
  });

  it("overwrites fresh when the input hash differs (different run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const s1 = seed(dir);
    prepareRunState(dir, s1);
    new WorkflowState(dir, s1).complete("plan", {}, []); // progress
    // different input -> different run -> fresh reseed wipes progress
    const s2 = { ...seed(dir), inputHash: "ih-2" };
    const r = prepareRunState(dir, s2);
    expect(r.resumed).toBe(false);
    expect(loadState(dir)!.phases.find((p) => p.id === "plan")!.status).toBe("pending");
  });
});
