# Template: Jira Story

A reusable description body for a Jira **Story** — the sprint-sized unit of user value. It
leads with the user narrative (in the summary), then gives the context, testable acceptance
criteria, design and technical notes, and a suggested breakdown: the 3 C's *card* that a
conversation then fills out.

## When to use

- Any user-facing, sprint-sized unit of work committed to a sprint.
- The unit of value you estimate and deliver in a few days (distinct from a multi-sprint
  Epic).

Publish with `jira_create_issue` (new) or `jira_update_issue` (refresh). Pass the body as
the `description` (plain text; converted to ADF automatically) and set `issueTypeName` to
`Story`. Link the parent via `fields.parent.key`. Other values go through `fields`. For rich
formatting (real headings, bullet lists, bold), build an ADF object and pass it to
`description` directly (see Notes).

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SUMMARY}}` | yes | The `summary` — the one-line user narrative `As a <persona>, I want <intent>, so that <benefit>`. **Persona, not job title; intent, not implementation.** ≤255 chars; keep the board-scannable "so that" within the first ~72 chars where possible. |
| `{{BACKGROUND_CONTEXT}}` | yes | *Background & context* — why this story, now; the data/feedback/design driving it. |
| `{{ACCEPTANCE_CRITERIA}}` | yes | *Acceptance criteria* — testable checklist (Given/When/Then for behaviour). Each AC maps to a test. |
| `{{DESIGN_NOTES}}` | no | *Design notes* — Figma links, component choices, UX constraints. Say `None.` if none. |
| `{{TECHNICAL_NOTES}}` | no | *Technical notes* — schema/API/algorithm sketches. Say `None.` if none. |
| `{{SUGGESTED_SUBTASKS}}` | no | *Suggested sub-tasks* — a starter breakdown (create as Sub-tasks or keep as a checklist). Optional. |

## Template body (Jira description, plain text)

```text
BACKGROUND & CONTEXT

{{BACKGROUND_CONTEXT}}

ACCEPTANCE CRITERIA

{{ACCEPTANCE_CRITERIA}}

DESIGN NOTES

{{DESIGN_NOTES}}

TECHNICAL NOTES

{{TECHNICAL_NOTES}}

SUGGESTED SUB-TASKS

{{SUGGESTED_SUBTASKS}}
```

## Notes for the filling-in agent

- **The narrative lives in the summary.** `As a <persona>, I want <intent>, so that
  <benefit>` — persona not job title (`first-time portfolio importer`, not `user`), intent
  not implementation (`import a CSV of holdings`, not `a file-upload component`). Leave the
  implementation to the conversation.
- **Publish mechanics.** `summary` → the `summary` param; the body above → the
  `description` param (plain text; the tool converts to ADF); `issueTypeName: "Story"`;
  `fields.parent.key` → the parent Epic/Feature; everything else via the `fields` map.
  Substitute **every** `{{TOKEN}}` — never publish a raw placeholder.
- **The ADF limit (repo-specific).** `jira_create_issue` converts plain text via
  `plainTextToAdf()`, which only produces `paragraph` / `hardBreak` / `text` nodes — **no
  real headings, bullet lists, or bold**. That's why section headers are ALL-CAPS lines
  (visual dividers) and `- ` / `**` markers render as literal text. A blank line starts a
  new paragraph; a single newline is a line break within a paragraph. If a section genuinely
  needs real lists/headings/bold, build an ADF object and pass it to `description` directly
  (the tool passes ADF objects through unchanged).
- **Acceptance criteria are the *confirmation*** (the 3rd C). Testable, one-AC-per-test.
  Default to a `- [ ]` checklist; use Given/When/Then for behavioural/backend specs. This is
  the part reviewers read most closely.
- **INVEST is a quality gate, not a format.** Run the draft through it in refinement
  (Independent, Negotiable, Valuable, Estimable, Small, Testable) — don't treat it as an
  alternative to the narrative.
- **Enabler / technical stories** may use a system persona (`As the import service, I want
  to retry transient failures…`). **Tasks and Bugs** may skip the narrative and use an
  imperative summary (`Fix CSV import crashing on empty rows`).
- **Recommended fields** (via `fields`): Story Points (native field, modified Fibonacci
  1/2/3/5/8/13 — keep most estimates in 1–13); `fields.parent.key`; `priority.name`;
  `fixVersions[].name`; `labels[]` (lowercase kebab-case, ≤10–15 — see repo conventions);
  `components[].name` (code areas: `core`/`api`/`cli`/`docs`/`infra`).
- **Definition of Ready.** A story is ready to pull when the summary + acceptance criteria
  are filled, it's estimated, dependencies are noted, and it fits a sprint.
- **Verify after publishing** with `jira_get_issue` (or `jira_issue`): confirm the summary,
  description, parent, and fields all landed.
