---
name: sf-flow-plan
description: Use when a user asks to create a structured multi-milestone implementation plan with pi-dynamic-workflows parallel research and iterative reviewer approval. Produces ai_plan/<slug>/.
---

# sf-flow-plan

## Prerequisites
Reviewer + researcher agents ensured at `~/.pi/agent/agents/`. Reviewer model resolved by the tool. `ai_plan/` is gitignored.

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `researcher` agent (matches `researcher.md`). Do NOT use the built-in `Explore` agent (it forces Haiku and cannot access web tools). If no researcher model is configured, omit `model` so it inherits the orchestrator.

**Models (self-resolve):** resolve each agent's model from `.pi/sf/flow/config.json` (project) then `~/.pi/sf/flow/config.json` (global), then the `SF_FLOW_<ROLE>_MODEL` env var (`reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer`); if still unset, omit `model` at dispatch so pi-subagents applies the agent `.md` `model:` or inherits the orchestrator. If a model was passed to you in your invocation context (the `sf_flow_*` tool echo on the direct path, or a workflow hint on the delegated path), use that — it wins. The tool's echo is visibility-only; you are the resolver. If a resolved spec is malformed or unresolvable, **omit `model:`** (inherit orchestrator) — never fabricate a hybrid `provider/id`.

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
Fan out N `researcher` agents via pi-dynamic-workflows `parallel()`, one per subsystem, each read-only (`subagent_type: "researcher"`; model from the tool echo, or inherit the orchestrator if unset). Synthesize a codebase map. **Do NOT use the built-in `Explore` agent — it forces Haiku.** (Extends pair/plan's single research agent into a fleet.)

### Phase 2: Gather Requirements
Ask clarifying questions ONE AT A TIME (AskUserQuestion) until the user says ready.

### Phase 3: Resolve Reviewer Model
(Already resolved by the tool.)

### Phase 4: Design (designer agent)
Dispatch the **designer** agent to produce the design via an interactive loop that YOU (the orchestrator) relay to the user. The designer is a subagent and cannot talk to the user directly.

Self-resolve the designer model (the `designer_model` tool param / prompt extraction → `.pi/sf/flow/config.json` → `SF_FLOW_DESIGNER_MODEL` → inherit orchestrator) and spawn it with `Agent({ subagent_type: "designer", model: "<designerModel>" })`. Seed it with: the original task, the Phase 1 research synthesis, and the Phase 2 clarifying answers.

The designer returns one of three payloads (a leading `STATUS:` line). Drive this loop:

1. **`STATUS: NEEDS_INFO`** — the designer lists questions. Ask the user those questions (one at a time, multiple-choice when possible), collect the answers, then RE-DISPATCH the designer with its previous context + the questions + the user's answers. Repeat until it has no more questions.
2. **`STATUS: APPROACHES`** — the designer returns 2–3 approaches with tradeoffs and a recommendation. Present them to the user; the user selects one or comments. RE-DISPATCH the designer with its previous context + the selection/comments. If the selection materially changes the design it returns `APPROACHES` again (revised); otherwise it returns `FINAL_DESIGN`.
3. **`STATUS: FINAL_DESIGN`** — the structured design doc for the agreed approach. Terminal; proceed to Phase 5.

Rules:
- YOU own all user interaction; the designer never addresses the user directly.
- Re-dispatch by spawning the designer fresh with the FULL accumulated context (it retains no state between spawns).
- On a delegated/auto path with no human gates, answer NEEDS_INFO with sensible defaults and auto-pick the recommended approach.

### Phase 5: Plan (planner agent)
Dispatch the **planner** agent to turn the approved design into an exhaustive milestone plan. Self-resolve the planner model (`.pi/sf/flow/config.json` → `SF_FLOW_PLANNER_MODEL` → inherit orchestrator) and spawn it with `Agent({ subagent_type: "planner", model: "<plannerModel>" })`, passing the FINAL_DESIGN from Phase 4 + the research synthesis.

The planner returns milestones + 2–5 min stories (`S-MN{seq}`), each meeting the Plan standard (all 7 fields, no vague verbs) and having run its **completeness self-check**. The orchestrator does NOT write the plan inline — it delegates entirely to the planner agent.

### Phase 6: Iterative Plan Review (delta-review, max 10 rounds)
**Round 1 (comprehensive):** Spawn the reviewer agent (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`) in comprehensive mode (full from-scratch review). Capture the reviewer's `## Findings` as the **canonical list**, assigning sequential IDs `F1`,`F2`,… via `assignFindingIds` (`src/audit/verification.ts`), sorted by severity (P0→P3) then file then line; render it with `renderCanonicalList`. The reviewer returns **REVISE** for ANY story missing required Plan-standard detail — **independent of correctness** — so under-detailed stories are caught even when the plan is technically right. If `APPROVED` on round 1 → Phase 7.

**Round N ≥ 2 (verification):** Re-spawn the **planner** (`Agent({ subagent_type: "planner", model: "<planner_model>" })`) with the canonical list, instructing it to address EACH `[Fn]` finding precisely (no regressions, minimal changes, report per-finding what changed). Then re-spawn the **reviewer** in **verification mode**: pass it the canonical `[Fn]` list + the round number + the revised plan. The reviewer classifies each prior finding as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED and reports only regressions traceable to a specific `[Fn]` fix in `## Findings`. The orchestrator NEVER edits the plan directly — it always re-spawns the planner. Parse the reviewer's verification with `parseVerification` and evolve the canonical list with `evolveCanonical` (drop FIXED, keep PARTIALLY-FIXED/NOT-FIXED, drop original + append regression for NEW-ISSUE, keep no-entry); reassign fresh IDs each round. Use the shared helpers in `src/audit/verification.ts`.

**APPROVED iff** `verificationApproved` is true: every prior BLOCKING (P0/P1/P2) finding is FIXED or NEW-ISSUE-INTRODUCED, AND no new blocking regression. P3 never blocks. On APPROVED → Phase 7.

**Cap:** Max **10 rounds** total (the round counter never resets). On exhaustion emit the best-effort plan and flag `⚠ NON-CONVERGENT: reviewer did not approve after 10 rounds; remaining findings listed in final-transcript.md` in the plan header, then proceed to Phase 7.

**Fresh-review reset (escape hatch):** if the planner's fix set touches >50% of the stories, the orchestrator MAY reset to a comprehensive round-1 review (clear the canonical list). The round counter does NOT reset. Default: reset at >50%.

> **Note:** The planner's fix step is what makes convergence possible — without it the reviewer sees the same artifact each round and the loop can never close.

### Phase 7: Generate Plan Files
Write `ai_plan/YYYY-MM-DD-<slug>/` with: `original-plan.md`, `final-transcript.md`, `milestone-plan.md`, `story-tracker.md`, `continuation-runbook.md`.

### Phase 8: Telegram Notification
Send completion summary via notify-telegram.sh if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set.

## Tracker Discipline
Update `story-tracker.md` before/after each story. Never proceed with stale state.
