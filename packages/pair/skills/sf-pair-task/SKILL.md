---
name: sf-pair-task
description: Execute a single task end-to-end with plan review, implementation review, verification, and one persistent task-plan artifact.
---

# sf-pair-task

Execute a single user task end-to-end: clarify, plan, review, implement, verify, review, commit.

## Prerequisites

- pi-subagents extension installed
- Reviewer model configured
- Obra Superpowers skills available to pi: `brainstorming`, `test-driven-development`, `verification-before-completion`, `finishing-a-development-branch` (install via `pi install git:github.com/obra/superpowers`)

## Process

### Phase 1: Preflight

1. Verify repo: `git rev-parse --is-inside-work-tree`
2. Ensure `ai_plan/` exists in `.gitignore`
3. Verify the reviewer agent definition exists globally: `test -f ~/.pi/agent/agents/reviewer.md`

### Phase 2: Parse Prompt And Clarify

1. Capture the user's prompt verbatim
2. Ask 1-3 clarifying questions one at a time using `AskUserQuestion`
3. Load `brainstorming` for behavior-changing work

### Phase 3: Initialize task-plan.md

1. Compute `ai_plan/YYYY-MM-DD-<slug>/`
2. Write `task-plan.md` from template
3. Fill all sections: Metadata, Prompt, Interpretation, Assumptions, Files, Approach, TDD Approach, Acceptance Criteria, Verification, Rollback
4. Set `Status: draft`

### Phase 4: Plan Review

1. Write task-plan content to `/tmp/pair-task-plan-{REVIEW_ID}.md`
2. Spawn reviewer:
   ```
   Agent({
     subagent_type: "reviewer",
     model: "<reviewer_model>",
     prompt: "Review the task plan at /tmp/pair-task-plan-{REVIEW_ID}.md",
     description: "Review task plan"
   })
   ```
3. Fix P0/P1/P2 findings until APPROVED
4. Set `Status: plan-approved`

### Phase 5: Execute

1. Set `Status: implementation-in-progress`
2. Load `test-driven-development` for behavior-changing edits
3. Implement following the plan to the letter
4. Update `task-plan.md` as acceptance criteria are completed

### Phase 6: Verification Gate

1. Load `verification-before-completion`
2. Run verification commands from task-plan.md
3. Fix failures until green

### Phase 7: Implementation Review

1. Build review payload from approved plan + diff + verification output
2. Spawn reviewer:
   ```
   Agent({
     subagent_type: "reviewer",
     model: "<reviewer_model>",
     prompt: "Review the implementation. [include diff and verification]",
     description: "Review implementation"
   })
   ```
3. Fix P0/P1/P2 findings until APPROVED
4. Set `Status: implementation-approved`

### Phase 8: Commit And Push

1. Load `finishing-a-development-branch`
2. Stage intended files
3. Create one commit
4. Ask whether to push or keep local

### Phase 9: Telegram Notification

If configured, send completion summary.
