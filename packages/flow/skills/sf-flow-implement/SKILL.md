---
name: sf-flow-implement
description: Use when a plan folder created by sf-flow-plan must be executed in a single worktree (flow/<slug>) with TDD per story and a non-optional audit gate before commit, then finalized so the branch is preserved for a PR.
---

# sf-flow-implement

## Prerequisites
Reviewer agent at `~/.pi/agent/agents/reviewer.md`; developer agent at `~/.pi/agent/agents/developer.md`. Models resolved by the tool (echoed) or self-resolved from config. ONE worktree created at `flow/<slug>` (git-only; non-git targets skip worktree).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `researcher` agent (matches `researcher.md`). Do NOT use the built-in `Explore` agent (it forces Haiku and cannot access web tools). If no researcher model is configured, omit `model` so it inherits the orchestrator.

**Models (self-resolve):** resolve each agent's model from `.pi/sf/flow/config.json` (project) then `~/.pi/sf/flow/config.json` (global), then the `SF_FLOW_<ROLE>_MODEL` env var (`reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer`); if still unset, omit `model` at dispatch so pi-subagents applies the agent `.md` `model:` or inherits the orchestrator. If a model was passed to you in your invocation context (the `sf_flow_*` tool echo on the direct path, or a workflow hint on the delegated path), use that — it wins. The tool's echo is visibility-only; you are the resolver.

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
2. **Per-milestone reviewer gate (delta-review, max 5 rounds).** Write the milestone diff + verification to `/tmp/flow-m<M>.diff`. **Round 1 (comprehensive):** dispatch the reviewer (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`) on the diff; capture the canonical `[Fn]` findings via `assignFindingIds` (`src/audit/verification.ts`); if `APPROVED` → next milestone. **Round N ≥ 2 (verification):** re-spawn the **developer** with the canonical list (address each `[Fn]` precisely, no regressions, minimal diff, report per-finding), then re-dispatch the reviewer in **verification mode** (pass canonical `[Fn]` list + round number + the new diff). The reviewer classifies each prior finding as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED and reports only regressions traceable to a fix in `## Findings`. The orchestrator does NOT edit code directly — it always re-spawns the developer. Evolve the canonical list with `evolveCanonical` (drop FIXED, keep PARTIALLY/NOT-FIXED, add regressions; reassign IDs). **APPROVED iff** `verificationApproved` (every prior blocking finding FIXED/NEW-ISSUE + no new blocking regression; P3 never blocks). **Cap:** Max **5 rounds** (matches `MAX_REVIEW_ITERATIONS`); on exhaustion emit best-effort + flag `⚠ NON-CONVERGENT: milestone M reviewer did not approve after 5 rounds`, then proceed (the Phase 5 audit gate is the safety net). **Fresh-review reset:** if the fix diff is >50% of the milestone diff lines, reset to a comprehensive round-1 review (clear the canonical list; the round counter does not reset).

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
