# Task Plan: [Task Title]

## Metadata

| Field | Value |
|-------|-------|
| **Status** | draft |
| **Created** | [YYYY-MM-DD] |
| **Reviewer Model** | [model] |
| **Review Rounds** | 0 |

### Status Enum

| Status | Meaning |
|--------|---------|
| `draft` | Initial plan, not yet reviewed |
| `plan-approved` | Plan reviewed and approved |
| `implementation-in-progress` | Currently implementing |
| `implementation-approved` | Implementation reviewed and approved |
| `completed` | Done, committed |

---

## Prompt

[User's original request verbatim]

---

## Interpretation

[Our understanding of what the user wants]

---

## Assumptions

- [Assumption 1]
- [Assumption 2]

---

## Files

### Files to Create

- `path/to/new/file.ts` — [purpose]

### Files to Modify

- `path/to/existing/file.ts` — [what changes]

### Files to Reference

- `path/to/reference.ts` — [why]

---

## Approach

[Step-by-step implementation plan]

### Step 1: [Description]

[Details]

### Step 2: [Description]

[Details]

---

## TDD Approach

### Test Strategy

[How we'll test this]

### Test Cases

1. [Test case 1]
2. [Test case 2]

---

## Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

---

## Verification

### Commands

```bash
[verification commands]
```

### Expected Output

[What we expect to see]

---

## Rollback

[How to undo if something goes wrong]

---

## Runtime State

| Field | Value |
|-------|-------|
| **Current Phase** | — |
| **Tests Passing** | — |
| **Typecheck Clean** | — |

---

## Review History

### Round 1

- **Reviewer:** [model]
- **Verdict:** [APPROVED | REVISE]
- **Findings:** [summary]

---

## Final Status

| Field | Value |
|-------|-------|
| **Outcome** | [success | failure | abandoned] |
| **Commit** | [hash] |
| **Duration** | [time] |

---

## Guardrails

- Follow the plan to the letter
- Do not skip verification
- Do not push without explicit approval
- Update this file as you work
