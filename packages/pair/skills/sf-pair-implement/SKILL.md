---
name: sf-pair-implement
description: Use when a plan folder created by sf-pair-plan must be executed with milestone verification, reviewer gates, and automatic worktree management.
---

# sf-pair-implement

Execute an existing plan milestone-by-milestone in a git worktree, with reviewer approval gates and automatic worktree lifecycle.

## Prerequisites

- pi-subagents extension installed
- A plan folder under `ai_plan/`
- Reviewer model configured
- Obra Superpowers skills available to pi: `verification-before-completion`, `finishing-a-development-branch` (install from https://github.com/obra/superpowers)

## Input Resolution

The tool receives a `path` parameter. Resolve it:

1. If path starts with `ai_plan/` → use as-is
2. Otherwise → treat as slug, resolve to `ai_plan/YYYY-MM-DD-<slug>/`
3. If multiple matches, list them and ask user to pick

## Process

### Phase 1: Locate Plan

1. Read `continuation-runbook.md` first
2. Read `story-tracker.md` to identify resume state
3. Read `milestone-plan.md` for the implementation spec

### Phase 2: Resolve Reviewer

Verify `.pi/agents/reviewer.md` exists. If not, stop and ask for model.

### Phase 3: Set Up Worktree

Create a git worktree:
- Branch: `pair/<slug>`
- Base: HEAD
- Install deps if missing (detect pnpm/npm/yarn)

Use the worktree helpers from `src/worktree/create.ts` via the tool's execute function. The skill instructs the agent to:

1. Run `git worktree add -b pair/<slug> <path> HEAD`
2. Run package manager install in the worktree directory
3. Switch to the worktree directory for implementation

### Phase 4: Execute Milestones

Do not stop between milestones. For each milestone:

1. Mark stories `in-dev` in `story-tracker.md`
2. Implement each story following the plan to the letter
3. Mark stories `completed` with commit hash in notes
4. Run verification (lint/typecheck/tests) for changed files
5. Spawn reviewer on milestone diff:
   ```
   Agent({
     subagent_type: "reviewer",
     prompt: "Review the milestone implementation. [include diff and verification output]",
     description: "Review milestone M<N>"
   })
   ```
6. If APPROVED → commit locally, mark milestone `approved`
7. If REVISE → fix findings, re-review

### Phase 5: Finalization

Once all milestones are approved and reviewed:

1. Switch to base branch
2. Merge worktree branch: `git merge --ff-only pair/<slug>`
3. Remove worktree: `git worktree remove <worktree-path>`
4. Delete branch: `git branch -d pair/<slug>`
5. Stop for user's final review

### Phase 6: Telegram Notification

If configured, send completion summary.
