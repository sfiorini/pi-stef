# Template: Jira Story

A reusable description body for a Jira **Story** — the sprint-sized unit of user value. It
leads with the user narrative (in the summary), then gives the context, testable acceptance
criteria, design and technical notes, and a suggested breakdown: the 3 C's *card* that a
conversation then fills out.

## When to use

- Any user-facing, sprint-sized unit of work committed to a sprint.
- The unit of value you estimate and deliver in a few days (distinct from a multi-sprint
  Epic).

Publish with `jira_create_issue` (new) or `jira_update_issue` (refresh). Set `issueTypeName`
to `Story`; link the parent via `fields.parent.key`; other values go through `fields`. For
the **description body** there are two paths: **plain text** via the top-level `description`
arg (converted to ADF, but NO bold/lists/code) or — **recommended for any non-trivial
story** — a pre-built **ADF object via `fields.description`** (bold headers, bullet lists,
inline code; stored verbatim). DO NOT pass an ADF object to the top-level `description` arg
— it gets stringified into one literal text node. See Notes.

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SUMMARY}}` | yes | The `summary` — the one-line user narrative `As a <persona>, I want <intent>, so that <benefit>`. **Persona, not job title; intent, not implementation.** ≤255 chars; keep the board-scannable "so that" within the first ~72 chars where possible. |
| `{{BACKGROUND_CONTEXT}}` | yes | *Background & context* — why this story, now; the data/feedback/design driving it. |
| `{{ACCEPTANCE_CRITERIA}}` | yes | *Acceptance criteria* — testable checklist (Given/When/Then for behaviour). Each AC maps to a test. |
| `{{DESIGN_NOTES}}` | no | *Design notes* — Figma links, component choices, UX constraints. Say `None.` if none. |
| `{{TECHNICAL_NOTES}}` | no | *Technical notes* — schema/API/algorithm sketches. Say `None.` if none. |
| `{{SUGGESTED_SUBTASKS}}` | no | *Suggested sub-tasks* — a starter breakdown; **create each as a Sub-task issue** via [`jira-subtask.md`](./jira-subtask.md) (imperative summary, parent = this Story). Optional. |

## Template body — ADF (recommended: bold headers + lists + inline code)

For any non-trivial story, publish the description as an **ADF object via `fields.description`**
(the plain-text path cannot do bold/lists/code — see Notes). **Section headers are bold
paragraphs** (a paragraph whose only content is one text node with
`marks:[{type:"strong"}]`); content under a header is a `paragraph` (prose) or a
`bulletList` of `listItem` paragraphs (steps / files / AC); every file path, function,
env var, and line ref is inline `code` (`marks:[{type:"code"}]`). Skeleton (substitute the
`{{TOKENS}}`; repeat list items / sections as needed):

```json
{
  "type": "doc", "version": 1, "content": [
    { "type": "paragraph", "content": [
      { "type": "text", "text": "CONTEXT", "marks": [{ "type": "strong" }] }
    ]},
    { "type": "paragraph", "content": [
      { "type": "text", "text": "{{BACKGROUND_CONTEXT}}" }
    ]},
    { "type": "paragraph", "content": [
      { "type": "text", "text": "ACCEPTANCE CRITERIA", "marks": [{ "type": "strong" }] }
    ]},
    { "type": "bulletList", "content": [
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [
        { "type": "text", "text": "Given/When/Then — " },
        { "type": "text", "text": "one AC per test", "marks": [{ "type": "code" }] }
      ] } ] }
    ]},
    { "type": "paragraph", "content": [
      { "type": "text", "text": "TECHNICAL NOTES", "marks": [{ "type": "strong" }] }
    ]},
    { "type": "paragraph", "content": [
      { "type": "text", "text": "{{TECHNICAL_NOTES}}" }
    ]}
  ]
}
```

Publish: `jira_create_issue({ projectKey, issueTypeName: "Story", summary, fields: { description: <ADF above>, parent: { key: "<EPIC>" }, /* components/labels/fixVersions/priority */ } })`
(or `jira_update_issue({ issueIdOrKey, fields: { description: <ADF> } })` to refresh).

## Template body — plain text (minimal fallback)

Only for the simplest stories. Section headers are ALL-CAPS lines — there is **no bold, no
real lists, no inline code** on this path (`- ` and `` ` `` render as literal text). A blank
line starts a new paragraph; a single newline is a line break within a paragraph.

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
- **Publish mechanics.** `summary` → the `summary` param; `issueTypeName: "Story"`;
  `fields.parent.key` → the parent Epic; components/labels/fixVersions/priority via `fields`.
  For the body: **plain text** → top-level `description` (no bold/lists/code); **ADF** →
  `fields.description` (bold headers + bullet lists + inline `code`; recommended for
  non-trivial stories). Never pass an ADF object to the top-level `description` — it
  stringifies. Substitute **every** `{{TOKEN}}` — never publish a raw placeholder.
- **Rich formatting (bold headers, lists, inline code) → pass ADF via `fields.description`.**
  The top-level `description` arg runs `plainTextToAdf()`, which (a) only emits
  `paragraph` / `hardBreak` / `text` nodes — **no bold, no real headings, no lists, no
  inline code** — and (b) **stringifies any object you pass** (a hand-built ADF object
  becomes one literal text node — double-serialized, useless). To get bold section headers
  + bullet lists + inline code, build an ADF `doc` and pass it through **`fields.description`**
  (the tool stores `fields.description` verbatim). This is the **recommended** path for any
  story with ≥3 sections or file/function/env-var/line refs.
  - **Bold header on its own line:** a paragraph whose only content is one text node with
    `marks:[{type:"strong"}]` — e.g. `{"type":"paragraph","content":[{"type":"text","text":"ACCEPTANCE CRITERIA","marks":[{"type":"strong"}]}]}`.
  - **Content under a header:** a `paragraph` (prose) or a `bulletList` of `listItem`
    paragraphs (steps / files / AC).
  - **Inline code** on every file path / function / env var / line ref:
    `{"type":"text","text":"src/upstream/baxia-token.ts","marks":[{"type":"code"}]}`.
  - **Verify** with `jira_get_issue(fields:["description"])` — it must return a `doc` with
    `strong`/`code` marks, NOT a single stringified text node.
  - **Large payloads:** hand-authoring big ADF JSON inline is error-prone (malformed-JSON
    400s). Build it programmatically (Python `dict` → `json.dumps`) and, if the MCP tool
    still 400s on size, PUT it via the Jira REST API directly
    (`PUT /rest/api/3/issue/<KEY>` with `{"fields":{"description": <adf>}}`).
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
  1/2/3/5/8/13 — keep most estimates in 1–13); `fields.parent.key` → the parent Epic;
  `priority.name` — `High` for Phase-1 stories, `Medium` for later; `fixVersions[].name` —
  the phase/quarter marker (e.g. `Q1`); `labels[]` — `enhancement` + the phase tag `phase-N`;
  `components[].name` — the **package name** (e.g. `qwen-proxy`, `finance-api` — never generic
  `api`/`infra`/`docs`).
- **Break the Story into Sub-tasks.** Fill `{{SUGGESTED_SUBTASKS}}` with imperative titles
  and **create each as a Sub-task issue** via [`jira-subtask.md`](./jira-subtask.md)
  (`issueTypeName: "Sub-task"`/`"Subtask"`, `fields.parent.key` = this Story, priority
  `Medium`). Story Points stay on the Story; Sub-tasks are not estimated.
- **Story ↔ Story `Blocks` links.** Express the dependency graph as issue links:
  `jira_create_issue_link typeName: "Blocks"`, where **outwardIssueKey = dependent** and
  **inwardIssueKey = prerequisite** (the prereq "blocks" the dependent — verified for the
  @pi-stef tool; re-verify the direction with one link if you ever switch Jira clients). Keep
  the graph transitively consistent with the Epic's milestone ordering.
- **Definition of Ready.** A story is ready to pull when the summary + acceptance criteria
  are filled, it's estimated, dependencies are noted, and it fits a sprint.
- **Verify after publishing** with `jira_get_issue` (or `jira_issue`): confirm the summary,
  description, parent, and fields all landed.
