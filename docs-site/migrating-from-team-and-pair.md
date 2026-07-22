# Migrating from @pi-stef/team and @pi-stef/pair

`@pi-stef/team` and `@pi-stef/pair` are **deprecated** in favor of
[`@pi-stef/flow`](/packages/flow). `flow` unifies pair's plan/implement/review
simplicity with `pi-dynamic-workflows` dynamic orchestration and a
CodeRabbit-style audit, and is the single package we are investing in going
forward.

Both packages remain installed and functional — nothing breaks — but their tools
now emit a migration banner pointing here.

## What to do

1. Install flow (if not already):
   ```bash
   pi install npm:@pi-stef/flow
   ```
2. Run `/sf-flow-seed` to ensure all agents (incl. `designer`) and the example
   workflows are current at `~/.pi/agent/agents/` and
   `~/.pi/sf/flow/workflows/`.
3. Switch your commands per the table below.

## Tool mapping

| Deprecated | Flow replacement | Notes |
|------------|------------------|-------|
| `/sf-pair-plan` | `/sf-flow-plan` | Multi-milestone plan, parallel research, iterative review. |
| `/sf-pair-implement` | `/sf-flow-implement` | Worktree TDD + a CodeRabbit-style audit gate before each commit (`flow/<slug>` branch). |
| `/sf-pair-task` | `/sf-flow-auto <workflow>` | Single end-to-end run, no human gates (or `/sf-flow-implement` on a one-milestone plan). |
| `/sf-pair-finalize` | `/sf-flow-finalize` | Identical: removes the worktree dir, preserves the branch for a PR. |
| `/sf-team-plan` | `/sf-flow-plan` | |
| `/sf-team-implement` | `/sf-flow-implement` | |
| `/sf-team-task` | `/sf-flow-auto <workflow>` | |
| `/sf-team-auto` | `/sf-flow-auto` | |
| `/sf-team-followup` | `/sf-flow-plan` → `/sf-flow-implement` | Plan a follow-up referencing the parent, then `/sf-flow-implement` to execute it (team's followup did both). |
| `/sf-team-resume` | re-run `/sf-flow-implement <slug>` | Plans are durable (`ai_plan/<slug>/`); resume continues from the story-tracker. |
| `/sf-team-steer` | native pi steering | Steer the flow orchestrator mid-run (pi's built-in steering). |

## How flow covers team's advanced features

- **Resume** — flow plans are durable artifacts. Re-running
  `/sf-flow-implement <slug>` picks up from `story-tracker.md` /
  `continuation-runbook.md` in the plan folder.
- **Steering** — use pi's native mid-run steering to redirect the flow
  orchestrator (no bespoke inbox needed).
- **Parallelism** — flow fans out multiple agents via `pi-dynamic-workflows`
  `parallel()` (the explorer fleet, parallel developers) where appropriate.

## Config migration

| pair / team | flow |
|-------------|------|
| `.pi/sf/pair/config.json` | `.pi/sf/flow/config.json` |
| `.pi/sf/team/config.json` | `.pi/sf/flow/config.json` |
| `SF_PAIR_REVIEWER_MODEL` | `SF_FLOW_REVIEWER_MODEL` |
| `SF_PAIR_EXPLORER_MODEL` | `SF_FLOW_EXPLORER_MODEL` |

Flow's `reviewer.md` is an **enhanced** version (a stricter HARD GATE on plan detail — pair's only says "check it's detailed enough"); `explorer.md` is equivalent. Agent seeding is **write-once**, so if you already have pair/team's files at `~/.pi/agent/agents/`, they are preserved and `/sf-flow-seed` writes flow's versions as `<name>.md.new` (without clobbering). To adopt flow's enhanced reviewer, delete the old file and re-seed:

```bash
rm ~/.pi/agent/agents/reviewer.md
/sf-flow-seed
```

Or diff `~/.pi/agent/agents/reviewer.md.new` against your existing file and merge manually.

## Why

`flow` is self-contained (it imports neither `@pi-stef/team` nor
`@pi-stef/agent-workflows`), uses `pi-subagents` + `pi-dynamic-workflows`
instead of a subprocess-orchestration layer, and adds the audit triad. One
package, one mental model, actively developed.
