import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canTransition,
  STORY_TRANSITIONS,
  milestoneApproved,
  assertValidTransition,
  parseTracker,
  type TrackerModel,
} from "../src/plan/tracker.js";
import { assertArtifacts } from "../src/contract/ops.js";

describe("tracker state model", () => {
  it("allows the legal forward path pending -> in-dev -> implemented -> approved", () => {
    expect(canTransition("pending", "in-dev")).toBe(true);
    expect(canTransition("in-dev", "implemented")).toBe(true);
    expect(canTransition("implemented", "approved")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("pending", "approved")).toBe(false); // skip steps
    expect(canTransition("approved", "in-dev")).toBe(false); // terminal
    expect(canTransition("pending", "pending")).toBe(false); // self
  });

  it("lets review-failed re-enter in-dev, and blocked re-enter in-dev", () => {
    expect(canTransition("review-failed", "in-dev")).toBe(true);
    expect(canTransition("blocked", "in-dev")).toBe(true);
  });

  it("approved is terminal (no outgoing edges)", () => {
    expect(STORY_TRANSITIONS.approved).toEqual([]);
  });
});

describe("assertValidTransition", () => {
  const t: TrackerModel = {
    stories: [
      { id: "S-M1-1", milestone: "M1", state: "in-dev" },
      { id: "S-M1-2", milestone: "M1", state: "approved", commit: "abc123" },
    ],
    milestones: { M1: "in-progress" },
  };

  it("rejects an illegal transition", () => {
    expect(assertValidTransition(t, "S-M1-1", "approved")).toContain(
      "S-M1-1: in-dev -> approved not allowed",
    );
  });

  it("requires a commit SHA for implemented/approved", () => {
    expect(assertValidTransition(t, "S-M1-1", "implemented")).toContain(
      "S-M1-1: implemented requires a commit SHA",
    );
    expect(assertValidTransition(t, "S-M1-1", "implemented", "def456")).toEqual([]);
  });

  it("reports an unknown story", () => {
    expect(assertValidTransition(t, "S-X-9", "approved")).toEqual(["story S-X-9 not found"]);
  });
});

describe("milestoneApproved", () => {
  it("is true only when every story in the milestone is approved", () => {
    const t: TrackerModel = {
      stories: [
        { id: "S-M1-1", milestone: "M1", state: "approved", commit: "a" },
        { id: "S-M1-2", milestone: "M1", state: "approved", commit: "b" },
      ],
      milestones: { M1: "approved" },
    };
    expect(milestoneApproved(t, "M1")).toBe(true);
  });
  it("is false when any story is not approved", () => {
    const t: TrackerModel = {
      stories: [
        { id: "S-M1-1", milestone: "M1", state: "approved", commit: "a" },
        { id: "S-M1-2", milestone: "M1", state: "implemented", commit: "b" },
      ],
      milestones: { M1: "review" },
    };
    expect(milestoneApproved(t, "M1")).toBe(false);
  });
  it("is false for a milestone with no stories", () => {
    expect(milestoneApproved({ stories: [], milestones: {} }, "M9")).toBe(false);
  });
});

describe("parseTracker", () => {
  it("parses story rows and ignores headers/separators", () => {
    const md = [
      "# Story tracker",
      "",
      "| Story | Milestone | State | Commit | Notes |",
      "|-------|-----------|-------|--------|-------|",
      "| S-M1-1 | M1 | in-dev | — | — |",
      "| S-M1-2 | M1 | approved | abc123 | done |",
      "",
      "| M1 | approved |", // non-story row (no S- prefix) -> ignored
    ].join("\n");
    const t = parseTracker(md)!;
    expect(t.stories).toHaveLength(2);
    expect(t.stories[0]).toMatchObject({ id: "S-M1-1", milestone: "M1", state: "in-dev", commit: undefined });
    expect(t.stories[1]).toMatchObject({ id: "S-M1-2", milestone: "M1", state: "approved", commit: "abc123" });
    expect(t.milestones.M1).toBe("pending");
  });

  it("treats — and empty as no commit", () => {
    const t = parseTracker("| S-M1-1 | M1 | pending | — | x |")!;
    expect(t.stories[0].commit).toBeUndefined();
  });

  it("returns null when there are no story rows", () => {
    expect(parseTracker("# no stories here\n| M1 | approved |")).toBeNull();
    expect(parseTracker("")).toBeNull();
  });
});

describe("assertArtifacts tracker assertions (S-M5-2)", () => {
  it("tracker_valid blocks when an approved story lacks a commit SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "story-tracker.md"), "| S-M1-1 | M1 | approved | — | x |\n");
    const r = assertArtifacts(dir, ["tracker_valid"]);
    expect(r.status).toBe("blocked");
    expect((r.trackerErrors ?? []).join(";")).toMatch(/commit SHA/);
  });

  it("tracker_valid succeeds when implemented/approved carry SHAs", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(
      join(dir, "story-tracker.md"),
      "| S-M1-1 | M1 | implemented | abc | x |\n| S-M1-2 | M1 | approved | def | y |\n",
    );
    const r = assertArtifacts(dir, ["tracker_valid"]);
    expect(r.status).toBe("success");
  });

  it("tracker_updated blocks when nothing advanced past pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "story-tracker.md"), "| S-M1-1 | M1 | pending | — | x |\n");
    const r = assertArtifacts(dir, ["tracker_updated"]);
    expect(r.status).toBe("blocked");
    expect((r.trackerErrors ?? []).join(";")).toMatch(/not advanced/);
  });

  it("tracker_updated succeeds when at least one story advanced", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    writeFileSync(join(dir, "story-tracker.md"), "| S-M1-1 | M1 | in-dev | — | x |\n");
    const r = assertArtifacts(dir, ["tracker_updated"]);
    expect(r.status).toBe("success");
  });
});
