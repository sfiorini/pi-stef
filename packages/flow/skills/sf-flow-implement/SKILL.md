---
name: sf-flow-implement
description: Use when a plan folder created by sf-flow-plan must be executed in a single worktree (flow/<slug>) with TDD per story and a non-optional audit gate before commit, then finalized so the branch is preserved for a PR.
---

# sf-flow-implement

## Prerequisites
Reviewer agent at `~/.pi/agent/agents/reviewer.md`; developer agent at `~/.pi/agent/agents/developer.md`. Models resolved by the tool (echoed) or self-resolved from config. ONE worktree created at `flow/<slug>` (git-only; non-git targets skip worktree).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `explorer` agent (matches `explorer.md`), NOT the built-in `Explore` (which forces Haiku). If no explorer model is configured, omit `model` so it inherits the orchestrator.

**Models (self-resolve):** resolve each agent's model from `.pi/sf/flow/config.json` (project) then `~/.pi/sf/flow/config.json` (global); if unset, omit `model` at dispatch so pi-subagents applies the agent `.md` `model:` or inherits the orchestrator. If a model was passed to you in your invocation context (the `sf_flow_*` tool echo on the direct path, or a workflow hint on the delegated path), use that — it wins. The tool's echo is visibility-only; you are the resolver.

## Process

### Phase 1: Locate Plan
Read `ai_plan/<slug>/continuation-runbook.md`, `story-tracker.md`, `milestone-plan.md`.

### Phase 2: Confirm Reviewer Agent
Reviewer at `~/.pi/agent/agents/reviewer.md` (global, write-once, no model in file). Pass model at dispatch.

### Phase 3: Worktree
(Already created by the tool — `cd` into it.)

### Phase 4: Execute Milestones (delegate to `developer` per milestone)
You are the ORCHESTRATOR — you write NO code; you always delegate. For EACH milestone:

1. **Delegate implementation.** Spawn the `developer` agent (`Agent({ subagent_type: "developer", model: "<developer_model>" })`, or omit `model` to inherit the orchestrator) with a self-contained task: the milestone's stories (read from `milestone-plan.md`), the plan path, and the repoRoot. The developer performs TDD red/green/refactor for that milestone's stories, runs typecheck+tests, updates `story-tracker.md`, and commits locally (no push). **Context continuity:** instruct the developer to read `story-tracker.md` + the recent `git log` first (see `agents/developer.md`).
2. **Per-milestone reviewer gate.** When the developer returns, write the milestone diff + verification to `/tmp/flow-m<M>.diff`, dispatch the reviewer (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`), parse the verdict, and address P0/P1/P2 by **re-spawning the developer** with specific fixes (the orchestrator does not edit code directly). Re-dispatch the reviewer until APPROVED.

**Missing-developer fallback:** if `developer.md` is absent (no `developer` agent resolves), spawn `general-purpose` with the orchestrator model + a self-contained dev-task prompt (TDD discipline, run tests, commit locally). The orchestrator NEVER falls back to implementing a milestone itself — it always delegates.

### Phase 5: Audit Gate (non-optional, before finalize)
Run `sf-flow-audit` on the accumulated diff. On REVISE (any P0/P1/P2): loop back to the failing STORY (re-spawn the `developer` with the specific fix — the orchestrator does not edit code), re-audit. Bounded by `audit.max_rounds` (default 5). P3: fix inline when cheap, else note.

### Phase 6: Finalization
`cd` back to main checkout, call `sf_flow_finalize` (removes worktree dir, preserves `flow/<slug>` branch). Send Telegram summary.

## Tracker Discipline
Update `story-tracker.md` before/after each story (the developer updates it as it works; the orchestrator verifies it stays current). Commit hash in Notes.

## Execution Rules
- The orchestrator writes NO code — it delegates every milestone to the `developer` agent and runs the reviewer gate.
- The `developer` runs lint/typecheck/tests per milestone and commits locally (no push).
- Proceed to the next milestone only after the current one's reviewer gate is APPROVED.
- After all milestones are approved, ask permission to push.
- Only after an approved push: mark the plan completed.
