# Template: Jira Sub-task

A reusable description body for a Jira **Sub-task** — the ≤1-day implementation slice that
breaks a Story into verifiable steps. In this repo's **three-tier Epic → Story → Sub-task**
hierarchy (mirrored from the `PISTFIN` project), Sub-tasks carry the concrete "what to build"
so the parent Story stays a unit of user value, not a task list.

## When to use

- Any Story that is larger than a day or has independent, verifiable steps (a schema
  migration, a route, a tool registration, a workflow file, …).
- The leaf of the hierarchy — Sub-tasks are **never** further decomposed; if one needs
  splitting, split the Story instead.

Publish with `jira_create_issue` (new) or `jira_update_issue` (refresh). Pass the body as
the `description` (plain text; converted to ADF automatically) and set `issueTypeName` to
`Sub-task` (next-gen / team-managed projects may name it `Subtask` — verify with
`jira_search_fields` once and reuse). Set `fields.parent.key` to the parent **Story**. Other
values go through `fields`.

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SUMMARY}}` | yes | The `summary` — an **imperative** phrase ≤72 chars: `Add …`, `Implement …`, `Wire …`, `Fix …`. Never a narrative ("As a …"); the narrative lives on the parent Story. |
| `{{DESCRIPTION}}` | yes | One line — the concrete deliverable (the file/route/migration/tool produced). Optional `None.` only when the summary is already fully self-describing. |

## Template body (Jira description, plain text)

```text
WHAT TO BUILD

{{DESCRIPTION}}

PARENT CONTEXT

Part of {{PARENT_STORY_SUMMARY}}.
```

> `{{PARENT_STORY_SUMMARY}}` is optional — drop the PARENT CONTEXT section when the parent
> link already conveys it.

## Notes for the filling-in agent

- **Summary is imperative, never a narrative.** `Add sf_fin_live_quote pi tool`, not
  `As a user, I want a tool …`. Implementation language, ≤72 chars (boards truncate).
- **Publish mechanics.** `summary` → the `summary` param; the body above → the `description`
  param (plain text; the tool converts to ADF); `issueTypeName: "Sub-task"` (or `"Subtask"`
  in next-gen projects); `fields.parent.key` → the parent **Story** (never an Epic);
  everything else via the `fields` map. Substitute **every** `{{TOKEN}}` — never publish a
  raw placeholder.
- **Inherit the parent's conventions.** `components[].name` = the **package** (e.g.
  `qwen-proxy`, `finance-api`); `labels[]` inherited from the parent (`enhancement` +
  `phase-N`); `assignee` = the owner; **`priority.name: "Medium"`** (Sub-tasks default Medium
  regardless of the parent Story's priority).
- **Do not estimate Sub-tasks.** Story Points live on the Story; Sub-tasks are not estimated.
- **The ADF limit (repo-specific).** `jira_create_issue` converts plain text via
  `plainTextToAdf()`, which only produces `paragraph` / `hardBreak` / `text` nodes — **no
  real headings, bullet lists, or bold**. That's why section headers are ALL-CAPS lines and
  `- ` / `**` markers render as literal text. Keep Sub-task bodies short (they're ≤1-day
  slices); if a Sub-task genuinely needs rich formatting, pass a pre-built ADF object as the
  `description`.
- **Verify after publishing** with `jira_get_issue` (or `jira_issue`): confirm the summary,
  description, parent Story, and fields all landed.
