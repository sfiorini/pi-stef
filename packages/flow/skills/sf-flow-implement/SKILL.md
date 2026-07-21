---
name: sf-flow-implement
description: Use when a plan folder created by sf-flow-plan must be executed in a single worktree (flow/<slug>) with TDD per story and a non-optional audit gate before commit, then finalized so the branch is preserved for a PR.
---

# sf-flow-implement

## Prerequisites
Reviewer agent at `~/.pi/agent/agents/reviewer.md`. Reviewer model resolved by the tool. ONE worktree created at `flow/<slug>` (git-only; non-git targets skip worktree).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `explorer` agent (matches `explorer.md`), NOT the built-in `Explore` (which forces Haiku). If no explorer model is configured, omit `model` so it inherits the orchestrator.

Models are resolved by the `sf_flow_*` tool and echoed in its output; pass the echoed model when you spawn an agent. If a model was not echoed, omit `model` to inherit the orchestrator.

## Process

### Phase 1: Locate Plan
Read `ai_plan/<slug>/continuation-runbook.md`, `story-tracker.md`, `milestone-plan.md`.

### Phase 2: Confirm Reviewer Agent
Reviewer at `~/.pi/agent/agents/reviewer.md` (global, write-once, no model in file). Pass model at dispatch.

### Phase 3: Worktree
(Already created by the tool — `cd` into it.)

### Phase 4: Execute Milestones (TDD per story)
For each story: mark `in-dev` in `story-tracker.md` → write failing test → red → implement → green → refactor → lint/typecheck/test → commit locally (do NOT push). Review loop per milestone: write diff+verification to `/tmp/flow-m<M>.diff`, dispatch reviewer (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`), parse verdict, fix P0/P1/P2, re-dispatch until APPROVED.

### Phase 5: Audit Gate (non-optional, before commit/finalize)
Run `sf-flow-audit` on the accumulated diff. On REVISE (any P0/P1/P2): loop back to the failing STORY (not the whole plan), re-implement, re-audit. Bounded by `audit.max_rounds` (default 5). P3: fix inline when cheap, else note. (Mirrors bigpowers build-epic step 6 → step 4.)

### Phase 6: Finalization
`cd` back to main checkout, call `sf_flow_finalize` (removes worktree dir, preserves `flow/<slug>` branch). Send Telegram summary.

## Tracker Discipline
Update `story-tracker.md` before/after each story. Commit hash in Notes.

## Execution Rules
- lint/typecheck/tests after each milestone (lint changed files only for speed)
- commit locally after each milestone (do NOT push)
- next milestone only after reviewer APPROVED
- after all milestones approved, ask permission to push
- only after approved push: mark plan completed
