# Template: Jira Epic

A reusable description body for a Jira **Epic** — the large, multi-sprint body of work that
groups Stories toward one outcome. It captures the goal and value, the scope and explicit
non-goals, the Epic-level acceptance criteria (its Definition of Done), the rollout shape,
and the dependencies and references behind it — in a structure consistent across every
Epic in this project.

## When to use

- Starting a large body of work that will span multiple sprints (roughly a month to a
  quarter).
- Any initiative that must answer: *why*, *what's in/out*, *how we'll know it's done*,
  *how it rolls out*, and *what it depends on*.

Publish with `jira_create_issue` (new) or `jira_update_issue` (refresh). Pass the body as
the `description` (plain text; converted to ADF automatically) and set `issueTypeName` to
`Epic`. Other values go through `fields`. For rich formatting (bold headers, bullet lists, inline code, tables), pass a pre-built
ADF object via **`fields.description`** — NOT the top-level `description` arg, which
stringifies it (see Notes). Epics also include an execution-order table (see that section
below).

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SUMMARY}}` | yes | The `summary` (issue header) — a short, scannable label ≤72 chars, e.g. `In-App Messaging v1`. **Not** a sentence; do **not** put sections here. |
| `{{GOAL_VALUE}}` | yes | *Goal & value* — why this Epic exists and the outcome it drives. Lead with user/business value; make the success metric explicit. |
| `{{SCOPE}}` | yes | *Scope* — what's in: the child stories/themes this Epic will deliver. |
| `{{OUT_OF_SCOPE}}` | yes | *Out of scope* — explicit non-goals. Prevents scope creep; never publish empty (say `None.` if truly none). |
| `{{EPIC_ACCEPTANCE_CRITERIA}}` | yes | *Epic-level acceptance criteria / Definition of Done* — 3–7 broad, outcome-oriented items. |
| `{{MILESTONES}}` | yes | *Key milestones & planned child stories* — the rollout shape across sprints (reference child story keys when known). |
| `{{REFERENCES}}` | yes | *Notes & references* — links to the PRD, research pages, design docs, and related Epics. |
| `{{DEPENDENCIES}}` | no | *Dependencies* — upstream/downstream Epics, teams, vendor deps. Use issue links for cross-issue deps. Say `None.` if none. |

## Template body (Jira description, plain text)

```text
GOAL & VALUE

{{GOAL_VALUE}}

SCOPE

{{SCOPE}}

OUT OF SCOPE

{{OUT_OF_SCOPE}}

EPIC-LEVEL ACCEPTANCE CRITERIA (EPIC DEFINITION OF DONE)

{{EPIC_ACCEPTANCE_CRITERIA}}

KEY MILESTONES & PLANNED CHILD STORIES

{{MILESTONES}}

DEPENDENCIES

{{DEPENDENCIES}}

NOTES & REFERENCES

{{REFERENCES}}
```

## Execution-order table (Epic convention)

Every Epic includes an **execution-order table** so the rollout is scannable at a glance.
Derive it from the child Stories' `Blocks` links (`inwardIssue` = prereq/blocker,
`outwardIssue` = dependent — see *Jira backlog conventions* in `AGENTS.md`). Columns:
**Order | Story | Milestone | Blocked by | Blocks**; mark parallel milestones with `∥`.

This is an ADF `table` node (only reachable via `fields.description` — plain text can't
render tables). Skeleton:

```json
{
  "type": "table", "attrs": { "layout": "default" }, "content": [
    { "type": "tableRow", "content": [
      { "type": "tableHeader", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Order" } ] } ] },
      { "type": "tableHeader", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Story" } ] } ] },
      { "type": "tableHeader", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Milestone" } ] } ] },
      { "type": "tableHeader", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Blocked by" } ] } ] },
      { "type": "tableHeader", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Blocks" } ] } ] }
    ] },
    { "type": "tableRow", "content": [
      { "type": "tableCell", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "1" } ] } ] },
      { "type": "tableCell", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "PISTQWE-45", "marks": [ { "type": "code" } ] } ] } ] },
      { "type": "tableCell", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "M1 — BaxiaTokenManager" } ] } ] },
      { "type": "tableCell", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "—" } ] } ] },
      { "type": "tableCell", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "M2 (46), M6 (50)" } ] } ] }
    ] }
  ]
}
```

Use `tableHeader` for the header row and `tableCell` for data; each cell wraps a `paragraph`.
Re-derive the rows whenever the `Blocks` links change.

## Notes for the filling-in agent

- **Summary is a label, not a sentence.** ≤72 chars (boards truncate). `In-App Messaging
  v1`, not `"We need to build in-app messaging so users can…"`. The narrative belongs in
  *Goal & value*. A `[Feature]`/`[Initiative]` prefix is fine when you want to signal Epic
  shape on the board. In pi-stef product projects (`PISTFIN`, `PISTQWE`, …) the convention is
  `<Product> — Phase N: <Title>` with an em-dash — e.g. `Qwen — Phase 1: MVP`,
  `Finance — Phase 1: Live-Data Foundation & Tracking MVP`.
- **Publish mechanics.** `summary` → the `summary` param; `issueTypeName: "Epic"`;
  components/labels/fixVersions/priority via `fields`. For the body: **plain text** → top-level
  `description` (no bold/lists/tables); **ADF** → `fields.description` (bold headers + bullet
  lists + the execution-order `table`; recommended). Never pass ADF to the top-level
  `description` — it stringifies. Substitute **every** `{{TOKEN}}` — never publish a raw
  placeholder.
- **The ADF limit (repo-specific).** `jira_create_issue` converts plain text via
  `plainTextToAdf()`, which only produces `paragraph` / `hardBreak` / `text` nodes — **no
  real headings, bullet lists, or bold**. That's why section headers are ALL-CAPS lines
  (visual dividers) and `- ` / `**` markers render as literal text. A blank line starts a
  new paragraph; a single newline is a line break within a paragraph. If a section genuinely
  needs real lists/headings/bold, build an ADF object and pass it through
  **`fields.description`** (the top-level `description` stringifies objects into one text
  node); see [`jira-story.md`](./jira-story.md) for the bold-header ADF pattern.
- **Out of scope must be honest.** It's the scope-creep guardrail; list the real non-goals.
  If there are none, say `None.` explicitly — never publish it empty.
- **Acceptance criteria are Epic-level.** Broad and outcome-oriented (3–7), distinct from
  each child Story's specific ACs. "All child Stories are Done" plus the outcome metric
  belong here.
- **Recommended fields** (via `fields`): `priority.name` — `High` for a Phase-1 Epic,
  `Medium` for later phases; `fixVersions[].name` — the **phase/quarter release marker**
  (e.g. `P1`, `Q1`; create it first via `jira_create_version` if it doesn't exist);
  `assignee` — the owner (DRI) via `accountId`; the native Epic *Target start* / *Target end*
  fields (they show on the Timeline/Roadmap); `labels[]` — `enhancement` + the phase tag
  `phase-N` (e.g. `phase-1`), plus optional topic tags; `components[].name` — the **package
  name** (pi-stef convention: one component per package, e.g. `qwen-proxy`, `finance-api`,
  `paths` — never generic `api`/`infra`/`docs`).
- **Hierarchy: Epic → Story → Sub-task.** pi-stef next-gen projects (PISTFIN-style) use a
  three-tier hierarchy with **no separate Feature type** (see `jira-feature.md`). Decompose
  this Epic into Stories (`jira-story.md`), and break each Story into Sub-tasks
  (`jira-subtask.md`); enumerate the child Stories in the Epic's *Scope* and *Key milestones*.
- **Links.** Capture cross-issue and cross-product relationships as links, not prose:
  (a) **Epic ↔ Confluence PRD** — attach the source PRD page to the Epic (relationship
  `implemented by`; via the Jira REST remotelink API — there is no MCP create-tool — or, as a
  fallback, name the PRD title + page id in *Notes & references* and add a comment);
  (b) **external remotelinks** — repos, upstream hosts, API docs attached at the Epic level
  with explicit relationship labels; (c) **issue links** — `blocks` / `relates to` between
  Stories/Epics via `jira_create_issue_link`.
- **Dependencies as links.** For cross-Epic deps, create issue links (`blocks` /
  `relates to`) rather than relying on prose; keep the prose summary here.
- **Verify after publishing** with `jira_get_issue` (or `jira_issue`): confirm the summary,
  description, parent, and fields all landed.
