---
name: sf-pair-implement
description: Use when a plan folder created by sf-pair-plan must be executed milestone-by-milestone in a worktree, with a per-milestone TDD→review→commit→tracker loop, then finalized so the branch is preserved for a PR.
disable-model-invocation: true
---

# sf-pair-implement

Execute an existing plan milestone-by-milestone in a git worktree. Each milestone runs the full TDD → review → commit → tracker cycle before the next. After all milestones, the worktree directory is removed but the `pair/<slug>` branch is preserved for a PR.

## Prerequisites

- pi-subagents extension installed
- A plan folder under `ai_plan/`
- Reviewer model configured
- The `sf_pair_implement` tool has already created the worktree and switched you into it
- Obra Superpowers skills available to pi: `test-driven-development`, `verification-before-completion`, `finishing-a-development-branch` (install via `pi install git:github.com/obra/superpowers`)

## Input Resolution

The tool received a `path` parameter and created a worktree on branch `pair/<slug>` at `<worktreePath>`. You are now inside that worktree directory. Reference the plan folder from the original checkout via the absolute path provided in the tool result.

## Process

### Phase 1: Locate Plan

1. Read `continuation-runbook.md` first.
2. Read `story-tracker.md` to identify the resume state.
3. Read `milestone-plan.md` for the implementation spec.

### Phase 2: Confirm Reviewer Agent

The `reviewer` agent definition is at `~/.pi/agent/agents/reviewer.md` (global, write-once, user-editable; no model in the file). The reviewer model was resolved by the tool and MUST be passed at dispatch time.

### Phase 3: Worktree

ALREADY DONE by the `sf_pair_implement` tool. Do not create another worktree. Confirm you are on branch `pair/<slug>` (`git branch --show-current`).

### Phase 4: Execute Milestones (one full cycle per milestone)

For EACH milestone, in order, run this exact cycle. Do NOT batch milestones.

**a) TDD each story.** For each story in the milestone:
1. Mark the story `in-dev` in `story-tracker.md`.
2. Load `test-driven-development` and implement the story test-first (red → green → refactor).
3. After each story passes its tests, mark it `completed` with the story's commit hash in Notes.

**b) Review loop.** Write the milestone diff + verification output to a temp file, then dispatch the reviewer with the resolved model:
```bash
git diff <baseSha> > /tmp/pair-milestone-<M>.diff
```
```
Agent({
  subagent_type: "reviewer",
  model: "<reviewer_model>",
  prompt: "Review the implementation for milestone <M>. Read /tmp/pair-milestone-<M>.diff. The reviewer is read-only and skeptical: verify the diff matches the plan, check for bugs/security/missing error handling, and do NOT let the implementer coach you to ignore findings. Return exactly: ## Summary, ## Findings (### P0/### P1/### P2/### P3, use '- None.' when empty), ## Verdict (VERDICT: APPROVED only if no P0/P1/P2).",
  description: "Review milestone <M>"
})
```
- If `VERDICT: APPROVED` with no P0/P1/P2 → proceed to (c).
- If REVISE → fix the P0/P1/P2 findings, re-run verification, re-write the diff file, and re-dispatch the reviewer. Repeat until APPROVED.

**c) Commit to the worktree branch.** Stage the milestone's intended files and create ONE commit on `pair/<slug>`:
```bash
git add <files>
git commit -m "feat(<slug>): milestone <M> <title>"
```
Commit ONLY to `pair/<slug>` (the worktree HEAD). Do not touch any base branch.

**d) Update tracker and advance.** Mark the milestone `approved` in `story-tracker.md` (record the commit hash). Update "Last Updated". Move to the next milestone and repeat from (a).

### Phase 5: Finalization

Once ALL milestones are approved and committed to `pair/<slug>`:

1. Return to the original checkout FIRST: `cd` back to the repo root (the main checkout, NOT the worktree). You must be outside the worktree before calling finalize.
2. Call the `sf_pair_finalize` tool with the `worktree_path` from the implement tool result. It removes the worktree directory but PRESERVES `pair/<slug>`.
3. Stop for the user's final review. Tell the user: branch `pair/<slug>` holds all milestone commits and is ready to push / open a PR. Do NOT push automatically.

### Phase 6: Telegram Notification

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, send a completion summary.
