---
name: sf-flow-implement
description: Use when a plan folder created by sf-flow-plan must be executed in a single worktree (flow/<slug>) with TDD per story and a non-optional audit gate before commit, then finalized so the branch is preserved for a PR.
---

# sf-flow-implement

## Prerequisites
Reviewer agent at the global agents dir (`getAgentDir()/agents/reviewer.md`, default `~/.pi/agent/agents/reviewer.md`); developer agent likewise at `developer.md`. Models are set in those `.md` files (the shipped files carry a commented tier hint the user uncomments) — the tool echo reports them. ONE worktree created at `flow/<slug>` (git-only; non-git targets skip worktree).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `researcher` agent (matches `researcher.md`). Do NOT use the built-in `Explore` agent (it forces Haiku and cannot access web tools).

**Models (from the agent .md):** each agent's model is set in its `.md` frontmatter (the shipped files carry a commented tier hint the user uncomments) — project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`; a `.md` with no `model:` inherits the orchestrator. **NEVER pass `model` at dispatch** — pi-subagents applies the `.md` model natively (frontmatter is authoritative), and passing one would override it. The tool echo's per-agent report is informational only.

## Process

### Phase 1: Locate Plan
Read `ai_plan/<slug>/continuation-runbook.md`, `story-tracker.md`, `milestone-plan.md`.

### Phase 2: Confirm Reviewer Agent
Reviewer at `getAgentDir()/agents/reviewer.md` (global, write-once). Do NOT pass `model` at dispatch — the `.md` carries it (or inherits the orchestrator).

### Phase 3: Worktree
(Already created by the tool — `cd` into it.)

### Phase 4: Execute Milestones (delegate to `developer` per milestone)
You are the ORCHESTRATOR — you write NO code; you always delegate. For EACH milestone:

1. **Delegate implementation.** Spawn the `developer` agent (`Agent({ subagent_type: "developer" })` — never pass `model`; `developer.md` carries it, else it inherits the orchestrator) with a self-contained task: the milestone's stories (read from `milestone-plan.md`), the plan path, and the repoRoot. The developer performs TDD red/green/refactor for that milestone's stories, runs typecheck+tests, updates `story-tracker.md`, and commits locally (no push). **Context continuity:** instruct the developer to read `story-tracker.md` + the recent `git log` first (see `agents/developer.md`).
2. **Per-milestone reviewer gate (delta-review, max 5 rounds).** Write the milestone diff + verification to `/tmp/flow-m<M>.diff`. **Round 1 (comprehensive):** dispatch the reviewer (`Agent({ subagent_type: "reviewer" })` — never pass `model`) on the diff; capture the canonical `[Fn]` findings via `assignFindingIds` (`src/audit/verification.ts`); if `APPROVED` → next milestone. **Round N ≥ 2 (verification):** re-spawn the **developer** with the canonical list (address each `[Fn]` precisely, no regressions, minimal diff, report per-finding), then re-dispatch the reviewer in **verification mode** (pass canonical `[Fn]` list + round number + the new diff). The reviewer classifies each prior finding as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED and reports only regressions traceable to a fix in `## Findings`. The orchestrator does NOT edit code directly — it always re-spawns the developer. Evolve the canonical list with `evolveCanonical` (drop FIXED, keep PARTIALLY/NOT-FIXED, add regressions; reassign IDs). **APPROVED iff** `verificationApproved` (every prior blocking finding FIXED/NEW-ISSUE + no new blocking regression; P3 never blocks). **Cap:** Max **5 rounds** (matches `MAX_REVIEW_ITERATIONS`); on exhaustion emit best-effort + flag `⚠ NON-CONVERGENT: milestone M reviewer did not approve after 5 rounds`, then proceed (the Phase 5 audit gate is the safety net). **Fresh-review reset:** if the fix diff is >50% of the milestone diff lines, reset to a comprehensive round-1 review (clear the canonical list; the round counter does not reset).

> **Note:** the reviewer gate is a fix loop, not a re-run — the developer addresses the called-out findings each round.

**Missing-developer fallback:** if `developer.md` is absent (no `developer` agent resolves), spawn `general-purpose` with a self-contained dev-task prompt (TDD discipline, run tests, commit locally) — no `model` needed (it inherits the orchestrator). The orchestrator NEVER falls back to implementing a milestone itself — it always delegates.

### Phase 5: Audit Gate (non-optional, before finalize)
Run `sf-flow-audit` on the accumulated diff. On REVISE (any P0/P1/P2): loop back to the failing STORY (re-spawn the `developer` with the specific fix — the orchestrator does not edit code), re-audit. Bounded by `audit.max_rounds` (default 5). P3: fix inline when cheap, else note.

> **Note:** `apply_fixes: false` is report-only by design — the audit produces findings + verdict without modifying code.

### Phase 6: Finalization
`cd` back to main checkout, call `sf_flow_finalize` (removes worktree dir, preserves `flow/<slug>` branch).

If `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, send a one-line completion summary:

```bash
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH" && notify-telegram.sh --message "<one-line summary>"
```

> The `export PATH=…` prepends the pi extension's `.bin` dir — the script is not on the default `PATH` in the agent shell, and each bash invocation is a fresh shell, so the `export` must be in the SAME command as the call (joined by `&&`).

## Tracker Discipline
Update `story-tracker.md` before/after each story (the developer updates it as it works; the orchestrator verifies it stays current). Commit hash in Notes.

## Execution Rules
- The orchestrator writes NO code — it delegates every milestone to the `developer` agent and runs the reviewer gate.
- The `developer` runs lint/typecheck/tests per milestone and commits locally (no push).
- Proceed to the next milestone only after the current one's reviewer gate is APPROVED.
- After all milestones are approved, ask permission to push.
- Only after an approved push: mark the plan completed.
