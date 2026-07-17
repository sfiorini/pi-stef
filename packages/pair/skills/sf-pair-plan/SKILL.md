---
name: sf-pair-plan
description: Use when a user asks to create a structured implementation plan with milestones, stories, and reviewer approval using pi-subagents.
---

# sf-pair-plan

Create a multi-milestone implementation plan with iterative reviewer approval.

## Prerequisites

- pi-subagents extension installed
- Reviewer model configured (via config, env, or prompt)
- Obra Superpowers skills available to pi: `brainstorming`, `writing-plans` (install via `pi install git:github.com/obra/superpowers`)

## Process

### Phase 1: Analyze

Explore the codebase and existing patterns. Use `Agent({ subagent_type: "general-purpose" })` to understand the project structure.

If an explorer model was configured (via prompt, config, or env), use it:
```
Agent({ subagent_type: "explorer", model: "<explorer_model>" })
```

If no explorer model is configured, omit the `model` parameter to inherit the current session model. Do NOT use the default `Explore` agent (it uses Haiku).

### Phase 2: Gather Requirements

Ask questions one at a time using `AskUserQuestion` until the scope is clear. Confirm constraints, success criteria, dependencies, and what is out of scope.

### Phase 3: Resolve Reviewer Model

The tool has already resolved the reviewer model. Verify the reviewer agent definition exists globally:

```
test -f ~/.pi/agent/agents/reviewer.md
```

If it doesn't exist, run the `sf_pair_plan` tool again (it writes the agent files on first use). The reviewer model MUST be passed at dispatch time.

### Phase 4: Design

Load `brainstorming` skill. Present 2-3 approaches and recommend one. Use `AskUserQuestion` to get the user's approval on the chosen approach before proceeding. Do NOT move to Phase 5 until the user confirms the design.

### Phase 5: Plan

Load `writing-plans` skill. Break the work into milestones and bite-sized stories (2-5 min each). Story IDs use `S-101`, `S-102` style.

Each story must be detailed enough for a less intelligent model to follow to the letter.

### Phase 6: Iterative Plan Review

#### Step 1: Write plan to temp file

Write the complete plan to `/tmp/pair-plan-{REVIEW_ID}.md` where REVIEW_ID is a random UUID.

#### Step 2: Spawn reviewer

```
Agent({
  subagent_type: "reviewer",
  model: "<reviewer_model>",
  prompt: "Review the implementation plan at /tmp/pair-plan-{REVIEW_ID}.md. Return exactly the required ## Summary, ## Findings (P0-P3), and ## Verdict structure.",
  description: "Review plan round N"
})
```

#### Step 3: Parse verdict

Scan the response for `VERDICT: APPROVED` (case-insensitive, line must start with `VERDICT:`).

- If found AND no P0/P1/P2 findings → proceed to Phase 7
- If not found OR P0/P1/P2 present → extract findings, fix, rewrite /tmp file, goto Step 2
- If max rounds (10) reached → stop, present outcome to user

### Phase 7: Generate Plan Files

**CRITICAL: The plan is NOT complete until ALL files are created in `ai_plan/`. Do NOT stop or ask the user how to proceed.**

Once the plan is approved by the reviewer, you MUST:

1. **Check `.gitignore`**: Run `grep -qx '/ai_plan/' .gitignore || echo '/ai_plan/' >> .gitignore`
2. **Create the plan folder**: `mkdir -p ai_plan/YYYY-MM-DD-<slug>/` (use today's date and a descriptive slug)
3. **Read the templates**: Read the 3 templates from the `templates/` directory (relative to this skill: `../../templates/`). Note: `task-plan.md` is for the task skill only — ignore it here.
4. **Write ALL 5 files** (use the same slug throughout):
   - `ai_plan/YYYY-MM-DD-<slug>/original-plan.md` — the raw approved plan from the review
   - `ai_plan/YYYY-MM-DD-<slug>/final-transcript.md` — conversation log of the planning session
   - `ai_plan/YYYY-MM-DD-<slug>/milestone-plan.md` — filled from `milestone-plan.md` template
   - `ai_plan/YYYY-MM-DD-<slug>/story-tracker.md` — filled from `story-tracker.md` template
   - `ai_plan/YYYY-MM-DD-<slug>/continuation-runbook.md` — filled from `continuation-runbook.md` template

5. **Verify all files exist**:
   ```
   ls -la ai_plan/YYYY-MM-DD-<slug>/
   ```
   If any file is missing, create it immediately.

6. **Present the plan folder to the user**: Show the file list and confirm the plan is ready for implementation.

**DO NOT:**
- Say "Plan complete" without creating the ai_plan/ folder
- Ask the user how to proceed with implementation
- Save the plan to any other location (docs/plans/, etc.)
- Skip any of the 5 required files

### Phase 8: Telegram Notification

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, send a completion summary via the Telegram notifier helper.
