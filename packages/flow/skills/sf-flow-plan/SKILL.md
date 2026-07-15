# sf-flow-plan

## Prerequisites
Reviewer + explorer agents ensured at `~/.pi/agent/agents/`. Reviewer model resolved by the tool. `ai_plan/` is gitignored.

## Process

### Phase 1: Analyze (parallel research)
Fan out N explorer agents via pi-dynamic-workflows `parallel()`, one per subsystem, each read-only. Synthesize a codebase map. (Extends pair/plan's single explorer into a fleet.)

### Phase 2: Gather Requirements
Ask clarifying questions ONE AT A TIME (AskUserQuestion) until the user says ready.

### Phase 3: Resolve Reviewer Model
(Already resolved by the tool.)

### Phase 4: Design (brainstorming skill)
Invoke superpowers:brainstorming. Present 2-3 approaches, recommend one.

### Phase 5: Plan (writing-plans skill)
Invoke superpowers:writing-plans. Milestones + 2-5 min stories (`S-MN{seq}`).

### Phase 6: Iterative Plan Review
Spawn the reviewer agent (`Agent({ subagent_type: "reviewer", model: "<reviewer_model>" })`). Parse verdict; fix P0/P1/P2; re-submit. Max 10 rounds.

### Phase 7: Generate Plan Files
Write `ai_plan/YYYY-MM-DD-<slug>/` with: `original-plan.md`, `final-transcript.md`, `milestone-plan.md`, `story-tracker.md`, `continuation-runbook.md`.

### Phase 8: Telegram Notification
Send completion summary via notify-telegram.sh if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set.

## Tracker Discipline
Update `story-tracker.md` before/after each story. Never proceed with stale state.
