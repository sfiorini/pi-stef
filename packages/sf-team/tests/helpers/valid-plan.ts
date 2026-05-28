/**
 * Test helper: produce a structurally valid plan body that passes
 * `sf_team_plan`'s post-approval plan-shape validators (length >= 200,
 * `hasRealMilestones`, `hasRealStories`).
 *
 * Tests that exercise other parts of `sf_team_plan` (revise forwarding,
 * transcript flow, TUI plumbing) want their planner-mocks to return
 * "valid-enough" content so the validators don't throw before the
 * test's assertion runs. Pass a `label` to embed it in the body for
 * round/v1-vs-v2 distinction tests; the label appears in goal text and
 * in story descriptions.
 */
export function validPlanText(label = "default"): string {
  return `# Plan: ${label}

## Goal
Test goal for ${label}; structurally valid per the M1 plan-shape validators.

## Architecture
TS module — sample architecture text for ${label}.

## Tech stack
TypeScript, vitest, pnpm.

## Milestones

### M0: Bootstrap

**Description:** Initial scaffolding for ${label}.

**Acceptance Criteria:**
- [ ] Module created.

**Stories:**
- **S-001 — First story for ${label}.** Body prose for ${label}.
- **S-002 — Second story for ${label}.** More body prose.

### M1: Implement

**Description:** Core feature for ${label}.

**Stories:**
- **S-101 — Add the thing for ${label}.** Body prose.

## Risks
None notable for ${label}.

## Execution Strategy

\`\`\`json
{
  "version": 1,
  "maxParallelMilestones": 1,
  "maxParallelStoriesPerMilestone": 1,
  "milestoneWaves": [
    {
      "id": "W1",
      "milestones": ["M0"],
      "maxParallel": 1
    },
    {
      "id": "W2",
      "milestones": ["M1"],
      "dependsOn": ["W1"],
      "maxParallel": 1
    }
  ],
  "stories": {
    "M0": {
      "storyWaves": [
        {
          "id": "M0-W1",
          "stories": ["S-001"],
          "writeSets": {
            "S-001": ["packages/sf-team/src/${label}-bootstrap.ts"]
          }
        },
        {
          "id": "M0-W2",
          "stories": ["S-002"],
          "dependsOn": ["M0-W1"],
          "writeSets": {
            "S-002": ["packages/sf-team/tests/${label}-bootstrap.test.ts"]
          }
        }
      ]
    },
    "M1": {
      "storyWaves": [
        {
          "id": "M1-W1",
          "stories": ["S-101"],
          "writeSets": {
            "S-101": ["packages/sf-team/src/${label}-core.ts"]
          }
        }
      ]
    }
  }
}
\`\`\`
`;
}
