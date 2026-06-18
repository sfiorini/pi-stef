[Plan Title]
==============

Overview
--------

*   **Goal:** [One sentence describing the end state]
*   **Created:** [YYYY-MM-DD]
*   **Status:** [Draft | In Review | Approved | In Progress | Completed]

Context
-------

### Requirements

[Numbered list of what the user asked for]

### Constraints

[Technical or process constraints]

### Success Criteria

[How we know when we're done]

Architecture
------------

### Design Decisions

| Decision | Chosen Approach | Rationale |
|----------|----------------|-----------|
| [Topic] | [What we chose] | [Why] |

### Component Relationships

```
[ASCII or mermaid diagram]
```

### Data Flow

[How data moves through the system]

Milestones
----------

### M1: [Milestone Name]

**Description:** [What this milestone delivers]

**Acceptance Criteria:**

*   [ ] [Testable criterion 1]
*   [ ] [Testable criterion 2]

**Stories:** S-101, S-102, S-103

**Milestone Completion Rule (MANDATORY):**

*   Run lint/typecheck/tests for changed files.
*   Commit locally (DO NOT push).
*   Stop and ask user for feedback.
*   Apply feedback, re-check changed files, commit again.
*   Move to next milestone only after user approval.

---

### M2: [Milestone Name]

[Same structure as M1]

---

Technical Specifications
------------------------

### Types & Interfaces

```typescript
[Type definitions]
```

### Constants & Enums

```typescript
[Constants and enums]
```

Files Inventory
---------------

File | Purpose | Milestone
--- | --- | ---
`path/to/file` | What it does | M1

---

Related Plan Files
------------------

This file is part of the plan folder under `ai_plan/`:

*   `original-plan.md` - Original approved plan (reference for original intent)
*   `final-transcript.md` - Final planning transcript (reference for rationale/context)
*   `milestone-plan.md` - This file (full specification)
*   `story-tracker.md` - Status tracking (must be kept up to date)
*   `continuation-runbook.md` - Resume/execution context (read first)
