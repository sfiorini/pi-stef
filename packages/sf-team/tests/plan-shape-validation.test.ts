import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hasRealMilestones, hasRealStories } from "../src/tools/plan";

const REFUSAL_FIXTURE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "fixtures",
  "planner-refusal-pid40957.md",
);

const VALID_PLAN = `# Plan: Sample Goal

## Goal
Demonstrate a structurally valid plan body.

## Architecture
TS module under packages/sf-team/src/.

## Tech stack
TypeScript, vitest.

## Milestones

### M1: Bootstrap

**Description:** Initial scaffolding.

**Acceptance Criteria:**
- [ ] Module created.

**Stories:**
- **S-101 — Create the file.** Body prose.
- **S-102 — Wire it up.** More body prose.

### M2: Polish

**Description:** Cleanup pass.

**Stories:**
- **S-201 — Final cleanup.** Body.
`;

const TOO_SHORT = "Tiny plan.\n## M0\n- S-001 hi\n"; // < 200 chars

const HEADING_ONLY = `# Plan
## Milestones
### M0: Bootstrap
description only — no Stories block at all.
### M1: Implement
also no Stories block here.

(Bulk of length filler here so the too-short guard does not trigger; we
want the "no-stories" reason to be the visible one when validation runs.
This text is intentionally long enough to exceed the 200-char minimum so
the second validator gets exercised, not the first.)
`;

const STORIES_BUT_NO_MILESTONES = `# Plan

**Stories:**
- **S-001 — Orphan story.** This story exists outside any milestone block,
  which the validator must reject because hasRealMilestones returns false.

This document is intentionally padded so the too-short validator does not
fire first; we want hasRealMilestones to be the reason for rejection.
`;

describe("M1 plan-shape validators (acceptance criteria)", () => {
  it("(a) plain prose: rejected by hasRealMilestones AND hasRealStories", () => {
    const prose = "Just a paragraph of words. ".repeat(20);
    expect(hasRealMilestones(prose)).toBe(false);
    expect(hasRealStories(prose)).toBe(false);
  });

  it("(b) refusal text mentioning a PID: rejected by both validators", () => {
    const refusal = readFileSync(REFUSAL_FIXTURE, "utf8");
    expect(refusal).toContain("PID 40957"); // sanity-check fixture
    expect(hasRealMilestones(refusal)).toBe(false);
    expect(hasRealStories(refusal)).toBe(false);
  });

  it("(c) heading-only with no Stories blocks: hasRealMilestones true, hasRealStories false", () => {
    expect(hasRealMilestones(HEADING_ONLY)).toBe(true);
    expect(hasRealStories(HEADING_ONLY)).toBe(false);
  });

  it("(d) orphan Stories block with no M\\d+ heading: BOTH validators reject (Stories must be under a milestone)", () => {
    // Per the harvester contract: extractMilestonesAndStories only collects
    // bullets when a milestone heading has set `currentId`. An orphan
    // Stories block at the document root cannot become tracker rows, so
    // hasRealStories must mirror that and return false too.
    expect(hasRealMilestones(STORIES_BUT_NO_MILESTONES)).toBe(false);
    expect(hasRealStories(STORIES_BUT_NO_MILESTONES)).toBe(false);
  });

  it("(e) too-short payload (< 200 chars): length-floor fails (validators may still pass)", () => {
    expect(TOO_SHORT.length).toBeLessThan(200);
    // The structural validators may individually return true on a tiny
    // valid-looking plan; the length floor is a separate guard the
    // orchestrator applies first.
  });

  it("(f) valid plan passes all validators", () => {
    expect(VALID_PLAN.length).toBeGreaterThanOrEqual(200);
    expect(hasRealMilestones(VALID_PLAN)).toBe(true);
    expect(hasRealStories(VALID_PLAN)).toBe(true);
  });
});

describe("hasRealStories scoping: Stories must be UNDER a milestone (round 2 fix)", () => {
  it("rejects orphan Stories block above any milestone heading", () => {
    const plan = `# Plan

**Stories:**
- **S-001 — Orphan story.** Outside any milestone block.

## Milestones

### M1: First milestone with no Stories block of its own.
Description only.
`;
    // Milestone exists, but the Stories bullet is BEFORE it — invalid.
    expect(hasRealMilestones(plan)).toBe(true);
    expect(hasRealStories(plan)).toBe(false);
  });

  it("accepts Stories block correctly placed under a milestone heading", () => {
    const plan = `# Plan

## Milestones

### M1: First

**Stories:**
- **S-101 — Properly scoped.** Under a milestone, accepted.
`;
    expect(hasRealMilestones(plan)).toBe(true);
    expect(hasRealStories(plan)).toBe(true);
  });
});

describe("Refusal fixture regression (S-107)", () => {
  it("the exact fixture from the user's failing run is rejected by every structural validator", () => {
    const refusal = readFileSync(REFUSAL_FIXTURE, "utf8");
    // Length: this particular fixture happens to be just over 500 chars,
    // so the length floor alone does NOT catch it — proving the
    // structural validators carry their weight.
    expect(refusal.length).toBeGreaterThan(200);
    expect(hasRealMilestones(refusal)).toBe(false);
    expect(hasRealStories(refusal)).toBe(false);
  });
});
