# Continuation Runbook: [Plan Title]

## Reference Files (START HERE)

Upon resumption, these files in this folder are the ONLY source of truth:

| File | Purpose | When to Use |
|------|---------|-------------|
| `continuation-runbook.md` | Full context reproduction + execution workflow | Read FIRST |
| `story-tracker.md` | Current progress and status | Check/update BEFORE and AFTER every story |
| `milestone-plan.md` | Complete plan with specifications | Reference implementation details |
| `original-plan.md` | Original approved plan | Reference original intent |
| `final-transcript.md` | Final planning transcript | Reference reasoning/context |

Do NOT reference planner-private files during implementation.

---

## Skill Workflow Guardrails

- Load relevant skills before action. If pi did not auto-load them, use `/skill:<name>`.
- Announce which skill is being used and why.
- If a checklist-driven workflow applies, keep its state current in the plan artifacts.
- Do not use deprecated wrapper CLIs.

---

## Quick Resume Instructions

1. Read this runbook completely.
2. Check `story-tracker.md`.
3. Find next `pending` story and mark as `in-dev` before starting.
4. Implement the story.
5. Update tracker immediately after each change.

---

## Mandatory Execution Workflow

Work from this folder (`ai_plan/[plan-slug]/`) and always follow this order:

1. Read `continuation-runbook.md` first.
2. Execute stories milestone by milestone.
3. After completing a milestone:
   - Run lint/typecheck/tests, prioritizing changed files for speed.
   - Commit locally (**DO NOT PUSH**).
   - Stop and ask user for feedback.
4. If feedback is provided:
   - Apply feedback changes.
   - Re-run checks for changed files.
   - Commit locally again.
   - Ask for milestone approval.
5. Only move to next milestone after explicit approval.
6. After all milestones are completed and approved:
   - Ask permission to push.
   - If approved, push.
   - Mark plan status as `completed`.

---

## Git Note

`ai_plan/` is intentionally local and must stay gitignored. Do not treat inability to commit plan-file updates inside `ai_plan/` as an error.

---

## Full Context Reproduction

### Project Overview

[Description of what we're building]

### User Requirements

[Numbered list of requirements]

### Scope

**In scope:**
- [Items]

**Out of scope:**
- [Items]

### Dependencies

- [External dependencies]

---

## Key Specifications

### Type Definitions

```typescript
[Types]
```

### Enums & Constants

```typescript
[Constants]
```

---

## Critical Design Decisions

| Decision | Chosen Approach | Alternatives Rejected | Rationale |
|----------|----------------|----------------------|-----------|
| [Topic] | [What] | [What else] | [Why] |

---

## Verification Commands

### Lint (changed files first)

```bash
[lint command]
```

### Typecheck

```bash
[typecheck command]
```

### Tests (target changed scope first)

```bash
[test command]
```

---

## File Quick Reference

| File | Purpose |
|------|---------|
| `original-plan.md` | Original approved plan |
| `final-transcript.md` | Final planning transcript |
| `milestone-plan.md` | Full specification |
| `story-tracker.md` | Current progress tracker |
| `continuation-runbook.md` | This runbook |
