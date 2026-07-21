---
name: sf-flow-plan
description: Use when a user asks to create a structured multi-milestone implementation plan with pi-dynamic-workflows parallel research and iterative reviewer approval. Produces ai_plan/<slug>/.
---

# sf-flow-plan

## Prerequisites
Reviewer + explorer agents ensured at `~/.pi/agent/agents/`. Reviewer model resolved by the tool. `ai_plan/` is gitignored.

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `explorer` agent (matches `explorer.md`), NOT the built-in `Explore` (which forces Haiku). If no explorer model is configured, omit `model` so it inherits the orchestrator.

Models are resolved by the `sf_flow_*` tool and echoed in its output; pass the echoed model when you spawn an agent. If a model was not echoed, omit `model` to inherit the orchestrator.

## Plan standard (exhaustive milestone plans)
Plans are consumed by an implementer that may be a weaker model, so every milestone plan MUST be exhaustive: each story must specify enough that a less-intelligent model can implement it with **ZERO remaining design decisions**. Vague verbs ("refactor", "improve", "handle", "update", "clean up") are FORBIDDEN unless accompanied by a concrete, unambiguous definition of the resulting change.

Every story MUST include all of:
1. **Files + lines** — exact file path(s) and the line ranges/functions to touch.
2. **Precise change** — the exact edit (before/after snippet, or an unambiguous description a junior could apply verbatim). No "improve X" without saying exactly what X becomes.
3. **Rationale** — why this change advances the goal (one line).
4. **Acceptance criteria** — the command(s) to run and the exact expected output (e.g. "`pnpm vitest run packages/flow/tests/config.test.ts` → green; typecheck clean").
5. **Edge cases / error handling** — what could go wrong and how the change handles it.
6. **Test expectations** — which test file/case to write or extend, and what it asserts.
7. **Dependencies** — story IDs this depends on (or "none").

The bar, stated for the implementer: *"I can do this story without asking any questions or making any design decisions."*

### Completeness self-check (run before finalizing the plan)
For every story, score it against the 7 fields above. If ANY field is missing or uses a vague verb without a concrete definition, EXPAND the story in place — do not finalize the plan until every story passes. Only then proceed to Phase 6 (review).

## Process

### Phase 1: Analyze (parallel research)
Fan out N `explorer` agents via pi-dynamic-workflows `parallel()`, one per subsystem, each read-only (`subagent_type: "explorer"`; model from the tool echo, or inherit the orchestrator if unset). Synthesize a codebase map. **Do NOT use the built-in `Explore` agent — it forces Haiku.** (Extends pair/plan's single explorer into a fleet.)

### Phase 2: Gather Requirements
Ask clarifying questions ONE AT A TIME (AskUserQuestion) until the user says ready.

### Phase 3: Resolve Reviewer Model
(Already resolved by the tool.)

### Phase 4: Design (brainstorming skill)
Invoke superpowers:brainstorming. Present 2-3 approaches, recommend one.

### Phase 5: Plan (writing-plans skill)
Invoke superpowers:writing-plans. Milestones + 2-5 min stories (`S-MN{seq}`). **Every story MUST meet the Plan standard** above: all 7 fields, no vague verbs. Run the **completeness self-check** on every story before finalizing the plan.

### Phase 6: Iterative Plan Review
Spawn the reviewer agent (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`). The reviewer returns **REVISE** for ANY story missing required Plan-standard detail — **independent of correctness** — so under-detailed stories are caught even when the plan is technically right. Also parse the verdict for P0/P1/P2; fix + re-submit. Max 10 rounds.

### Phase 7: Generate Plan Files
Write `ai_plan/YYYY-MM-DD-<slug>/` with: `original-plan.md`, `final-transcript.md`, `milestone-plan.md`, `story-tracker.md`, `continuation-runbook.md`.

### Phase 8: Telegram Notification
Send completion summary via notify-telegram.sh if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set.

## Tracker Discipline
Update `story-tracker.md` before/after each story. Never proceed with stale state.
