import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSequentialExecutionStrategyArtifact,
  ExecutionStrategyValidationError,
  loadExecutionStrategyForPlanFolder,
  parseExecutionStrategyText,
  validateExecutionStrategy,
  type ExecutionStrategy,
} from "../src/plan/execution-strategy";
import { EXECUTION_STRATEGY_FILE, planFolderPath } from "../src/plan/paths";
import { parseTrackerText } from "../src/plan/tracker";

const TRACKER = `# Story Tracker

## Milestones

### M1: Pane Theme

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | first | pending | |
| S-102 | second | pending | |

**Approval Status:** pending

### M2: Strategy

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-201 | third | pending | |

**Approval Status:** pending
`;

const tracker = parseTrackerText(TRACKER);

function validStrategy(overrides: Partial<ExecutionStrategy> = {}): ExecutionStrategy {
  return {
    version: 1,
    maxParallelMilestones: 2,
    maxParallelStoriesPerMilestone: 2,
    milestoneWaves: [
      {
        id: "W1",
        milestones: ["M1", "M2"],
        maxParallel: 2,
      },
    ],
    stories: {
      M1: {
        maxParallelStories: 2,
        storyWaves: [
          {
            id: "M1-W1",
            stories: ["S-101", "S-102"],
            maxParallel: 2,
            writeSets: {
              "S-101": ["packages/sf-team/src/pane-theme.ts"],
              "S-102": ["packages/sf-team/tests/pane-theme.test.ts"],
            },
          },
        ],
      },
      M2: {
        storyWaves: [
          {
            id: "M2-W1",
            stories: ["S-201"],
            writeSets: {
              "S-201": ["packages/sf-team/src/plan/execution-strategy.ts"],
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

function tmp(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-strategy-"));
  const slug = "2026-05-04-strategy";
  mkdirSync(planFolderPath(root, slug), { recursive: true });
  writeFileSync(path.join(planFolderPath(root, slug), "story-tracker.md"), TRACKER);
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("execution strategy parsing", () => {
  it("extracts fenced JSON from a `## Execution Strategy` section", () => {
    const plan = `# Plan

## Execution Strategy

\`\`\`json
${JSON.stringify(validStrategy(), null, 2)}
\`\`\`
`;
    const parsed = parseExecutionStrategyText(plan);
    expect(parsed).not.toBeNull();
    expect(parsed?.milestoneWaves[0].milestones).toEqual(["M1", "M2"]);
  });

  it("returns null when no JSON strategy artifact exists", () => {
    expect(parseExecutionStrategyText("# Plan\n\n## Milestones\n\n### M1: x")).toBeNull();
  });

  it("rejects the legacy array-of-arrays milestone wave shape with a path-specific error", () => {
    const plan = `# Plan

## Execution Strategy

\`\`\`json
{
  "version": 1,
  "maxParallelMilestones": 2,
  "maxParallelStoriesPerMilestone": 2,
  "milestoneWaves": [
    ["M1"],
    ["M2"]
  ],
  "milestones": {
    "M1": {
      "dependsOn": [],
      "stories": [
        { "wave": 1, "ids": ["S-101"], "writeSets": ["packages/sf-team/src/a.ts"] }
      ]
    }
  }
}
\`\`\`
`;
    expect(() => parseExecutionStrategyText(plan)).toThrow(/milestoneWaves\[0\].*object.*id.*milestones/i);
  });
});

describe("execution strategy validation", () => {
  it("validates a parallel milestone/story strategy against the tracker", () => {
    const resolved = validateExecutionStrategy(validStrategy(), tracker, { source: "plan" });
    expect(resolved.source).toBe("plan");
    expect(resolved.milestoneWaves[0].milestones).toEqual(["M1", "M2"]);
    expect(resolved.stories.M1.storyWaves[0].stories).toEqual(["S-101", "S-102"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("rejects unknown milestone ids", () => {
    expect(() =>
      validateExecutionStrategy(validStrategy({ milestoneWaves: [{ id: "W1", milestones: ["M9"] }] }), tracker),
    ).toThrow(ExecutionStrategyValidationError);
  });

  it("rejects non-object milestone and story waves with path-specific errors", () => {
    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        milestoneWaves: [["M1"]] as never,
      }, tracker),
    ).toThrow(/milestoneWaves\[0\].*object.*id.*milestones/i);

    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        stories: {
          M1: {
            storyWaves: [["S-101"]] as never,
          },
          M2: validStrategy().stories!.M2,
        },
      }, tracker),
    ).toThrow(/stories\.M1\.storyWaves\[0\].*object.*id.*stories/i);
  });

  it("rejects unknown story ids and stories assigned to the wrong milestone", () => {
    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        stories: {
          M1: {
            storyWaves: [
              {
                id: "M1-W1",
                stories: ["S-201"],
                writeSets: { "S-201": ["x.ts"] },
              },
            ],
          },
        },
      }, tracker),
    ).toThrow(/does not belong to M1/);
  });

  it("rejects duplicate milestone/story ids across active waves", () => {
    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        milestoneWaves: [
          { id: "W1", milestones: ["M1"] },
          { id: "W2", milestones: ["M1"] },
        ],
      }, tracker),
    ).toThrow(/Duplicate milestone/);

    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        milestoneWaves: [
          { id: "W1", milestones: ["M1"] },
          { id: "W2", milestones: ["M2"], dependsOn: ["W1"] },
        ],
        stories: {
          M1: {
            storyWaves: [
              { id: "A", stories: ["S-101"], writeSets: { "S-101": ["a.ts"] } },
              { id: "B", stories: ["S-101"], writeSets: { "S-101": ["b.ts"] } },
            ],
          },
          M2: validStrategy().stories!.M2,
        },
      }, tracker),
    ).toThrow(/Duplicate story/);
  });

  it("rejects cyclic wave dependencies", () => {
    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        milestoneWaves: [
          { id: "W1", milestones: ["M1"], dependsOn: ["W2"] },
          { id: "W2", milestones: ["M2"], dependsOn: ["W1"] },
        ],
      }, tracker),
    ).toThrow(/Cycle/);
  });

  it("clamps oversized parallel caps but rejects invalid unbounded caps", () => {
    const resolved = validateExecutionStrategy(
      validStrategy({ maxParallelMilestones: 999, maxParallelStoriesPerMilestone: 999 }),
      tracker,
      { maxParallelMilestones: 4, maxParallelStoriesPerMilestone: 8 },
    );
    expect(resolved.maxParallelMilestones).toBe(4);
    expect(resolved.maxParallelStoriesPerMilestone).toBe(8);
    expect(resolved.warnings.join("\n")).toMatch(/clamped/i);

    expect(() => validateExecutionStrategy(validStrategy({ maxParallelMilestones: Number.POSITIVE_INFINITY }), tracker))
      .toThrow(/maxParallelMilestones/);
    expect(() => validateExecutionStrategy(validStrategy({ maxParallelStoriesPerMilestone: 0 }), tracker))
      .toThrow(/maxParallelStoriesPerMilestone/);
  });

  it("rejects overlapping write sets in parallel story and milestone waves", () => {
    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        stories: {
          M1: {
            storyWaves: [
              {
                id: "M1-W1",
                stories: ["S-101", "S-102"],
                maxParallel: 2,
                writeSets: {
                  "S-101": ["packages/sf-team/src/shared.ts"],
                  "S-102": ["packages/sf-team/src/shared.ts"],
                },
              },
            ],
          },
        },
      }, tracker),
    ).toThrow(/write set conflict/);

    expect(() =>
      validateExecutionStrategy({
        ...validStrategy(),
        stories: {
          M1: {
            storyWaves: [
              {
                id: "M1-W1",
                stories: ["S-101"],
                writeSets: { "S-101": ["packages/sf-team/src/shared.ts"] },
              },
              {
                id: "M1-W2",
                stories: ["S-102"],
                dependsOn: ["M1-W1"],
                writeSets: { "S-102": ["packages/sf-team/src/pane-theme.ts"] },
              },
            ],
          },
          M2: {
            storyWaves: [
              {
                id: "M2-W1",
                stories: ["S-201"],
                writeSets: { "S-201": ["packages/sf-team/src/shared.ts"] },
              },
            ],
          },
        },
      }, tracker),
    ).toThrow(/write set conflict/);
  });
});

describe("execution strategy plan-folder loading", () => {
  it("loads and validates execution-strategy.json when present", async () => {
    const { root, slug, dispose } = tmp();
    try {
      writeFileSync(
        path.join(planFolderPath(root, slug), EXECUTION_STRATEGY_FILE),
        JSON.stringify(validStrategy(), null, 2),
      );
      const loaded = await loadExecutionStrategyForPlanFolder(root, slug);
      expect(loaded.source).toBe("file");
      expect(loaded.milestoneWaves[0].milestones).toEqual(["M1", "M2"]);
    } finally {
      dispose();
    }
  });

  it("falls back to a sequential strategy for old five-file plan folders", async () => {
    const { root, slug, dispose } = tmp();
    try {
      const loaded = await loadExecutionStrategyForPlanFolder(root, slug);
      expect(loaded.source).toBe("sequential-fallback");
      expect(loaded.milestoneWaves.map((w) => w.milestones)).toEqual([["M1"], ["M2"]]);
      expect(loaded.stories.M1.storyWaves.map((w) => w.stories)).toEqual([["S-101"], ["S-102"]]);
      expect(loaded.maxParallelMilestones).toBe(1);
      expect(loaded.maxParallelStoriesPerMilestone).toBe(1);
    } finally {
      dispose();
    }
  });

  it("throws a path-specific validation error for malformed execution-strategy.json", async () => {
    const { root, slug, dispose } = tmp();
    try {
      writeFileSync(
        path.join(planFolderPath(root, slug), EXECUTION_STRATEGY_FILE),
        JSON.stringify({
          version: 1,
          maxParallelMilestones: 2,
          maxParallelStoriesPerMilestone: 2,
          milestoneWaves: [["M1"], ["M2"]],
        }, null, 2),
      );
      await expect(loadExecutionStrategyForPlanFolder(root, slug)).rejects.toThrow(
        /milestoneWaves\[0\].*object.*id.*milestones/i,
      );
    } finally {
      dispose();
    }
  });

  it("can build a sequential artifact from tracker data for fallback writes", () => {
    const artifact = buildSequentialExecutionStrategyArtifact(tracker);
    expect(artifact.milestoneWaves.map((w) => w.milestones)).toEqual([["M1"], ["M2"]]);
    expect(artifact.stories!.M1.storyWaves.map((w) => w.stories)).toEqual([["S-101"], ["S-102"]]);
  });
});

describe("writeSet path safety (normalizeWritePath via validateExecutionStrategy)", () => {
  // The path-safety regex lives at `src/plan/execution-strategy.ts:539`
  // inside `normalizeWritePath`, which is called from `normalizeWriteSets`
  // which is called from `validateExecutionStrategy`. The JSON-shape parser
  // (`parseExecutionStrategyText`) does NOT exercise these rules.

  const withWriteSet = (paths: string[]): ExecutionStrategy =>
    validStrategy({
      stories: {
        M1: {
          maxParallelStories: 1,
          storyWaves: [
            {
              id: "M1-W1",
              stories: ["S-101", "S-102"],
              maxParallel: 1,
              writeSets: {
                "S-101": paths,
                "S-102": ["packages/sf-team/tests/pane-theme.test.ts"],
              },
            },
          ],
        },
        M2: {
          storyWaves: [
            {
              id: "M2-W1",
              stories: ["S-201"],
              writeSets: { "S-201": ["packages/sf-team/src/plan/execution-strategy.ts"] },
            },
          ],
        },
      },
    });

  describe("dynamic-route segments are allowed (Next.js / SvelteKit / Remix / Astro / Nuxt)", () => {
    it("[caseId] segment", () => {
      const resolved = validateExecutionStrategy(
        withWriteSet(["src/app/cases/[caseId]/page.tsx"]),
        tracker,
      );
      expect(resolved.stories.M1.storyWaves[0].writeSets["S-101"]).toEqual([
        "src/app/cases/[caseId]/page.tsx",
      ]);
    });

    it("[...slug] catch-all segment", () => {
      const resolved = validateExecutionStrategy(
        withWriteSet(["src/app/docs/[...slug]/page.tsx"]),
        tracker,
      );
      expect(resolved.stories.M1.storyWaves[0].writeSets["S-101"]).toEqual([
        "src/app/docs/[...slug]/page.tsx",
      ]);
    });

    it("[[...slug]] optional catch-all segment", () => {
      const resolved = validateExecutionStrategy(
        withWriteSet(["src/app/[[...slug]]/page.tsx"]),
        tracker,
      );
      expect(resolved.stories.M1.storyWaves[0].writeSets["S-101"]).toEqual([
        "src/app/[[...slug]]/page.tsx",
      ]);
    });

    it("{group} brace segment", () => {
      const resolved = validateExecutionStrategy(
        withWriteSet(["app/{group}/page.tsx"]),
        tracker,
      );
      expect(resolved.stories.M1.storyWaves[0].writeSets["S-101"]).toEqual([
        "app/{group}/page.tsx",
      ]);
    });

    it("mixed brackets + braces (Next.js parallel + group routes)", () => {
      const resolved = validateExecutionStrategy(
        withWriteSet(["src/app/(public)/[lang]/page.tsx"]),
        tracker,
      );
      expect(resolved.stories.M1.storyWaves[0].writeSets["S-101"]).toEqual([
        "src/app/(public)/[lang]/page.tsx",
      ]);
    });
  });

  describe("shell-glob wildcards remain rejected", () => {
    it("rejects `*` in writeSet path", () => {
      expect(() =>
        validateExecutionStrategy(withWriteSet(["src/app/page-*.tsx"]), tracker),
      ).toThrow(ExecutionStrategyValidationError);
      try {
        validateExecutionStrategy(withWriteSet(["src/app/page-*.tsx"]), tracker);
      } catch (err) {
        expect(String((err as Error).message)).toMatch(/\*|glob/i);
      }
    });

    it("rejects `?` in writeSet path", () => {
      expect(() =>
        validateExecutionStrategy(withWriteSet(["src/app/page?.tsx"]), tracker),
      ).toThrow(ExecutionStrategyValidationError);
    });
  });

  describe("other unsafe forms remain rejected", () => {
    it("rejects absolute paths", () => {
      expect(() =>
        validateExecutionStrategy(withWriteSet(["/etc/passwd"]), tracker),
      ).toThrow(ExecutionStrategyValidationError);
    });

    it("rejects `..` parent-traversal segments", () => {
      expect(() =>
        validateExecutionStrategy(withWriteSet(["../secrets.ts"]), tracker),
      ).toThrow(ExecutionStrategyValidationError);
    });

    it("rejects placeholder literals: all, unknown, tbd (case-insensitive)", () => {
      for (const literal of ["all", "ALL", "unknown", "UNKNOWN", "tbd", "TBD"]) {
        expect(() =>
          validateExecutionStrategy(withWriteSet([literal]), tracker),
        ).toThrow(ExecutionStrategyValidationError);
      }
    });
  });
});
