# Template: Jira Feature

A reusable description body for a Jira **Feature** — the mid-tier shippable increment (the
SAFe framing) that carries a benefit hypothesis, non-functional requirements, and
outcome-focused acceptance criteria. In this repo's recommended **two-tier Epic → Story**
model the Feature body is dropped into an Epic; it also works verbatim on a custom
`Feature` issue type if the team later adopts one.

## When to use

- A shippable increment of value within a quarter/PI — bigger than a Story, smaller and
  more focused than a portfolio-spanning Epic.
- When you want the *benefit hypothesis* and *non-functional requirements* to be first-class
  parts of the work item, not buried in a Story.

Publish with `jira_create_issue` (new) or `jira_update_issue` (refresh). Pass the body as
the `description` (plain text; converted to ADF automatically). Set `issueTypeName` to
`Epic` (Option C — recommended, two-tier) **or** to a custom `Feature` type (Option A). Other
values go through `fields`. For rich formatting (real headings, bullet lists, bold), build
an ADF object and pass it to `description` directly (see Notes).

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SUMMARY}}` | yes | The `summary` — a short label ≤72 chars. Prefix `[Feature]` when you want to flag Feature-shape on the board (recommended under Option C, where the Feature lives in an Epic). |
| `{{PROBLEM_STATEMENT}}` | yes | *Problem statement* — the user/business pain, naming the user and the context. |
| `{{BENEFIT_HYPOTHESIS}}` | yes | *Benefit hypothesis* — `We believe <business outcome> will be achieved if <users> successfully achieve <user outcome> with <this feature>.` |
| `{{SCOPE}}` | yes | *Scope* — what's in. |
| `{{NON_FUNCTIONAL_REQUIREMENTS}}` | yes | *Non-functional requirements* — performance, security, accessibility, observability, i18n. Never publish empty. |
| `{{ACCEPTANCE_CRITERIA}}` | yes | *Acceptance criteria* — outcome-focused; prefer Given/When/Then for behavior. |
| `{{MILESTONES_ENABLERS}}` | yes | *Key milestones & enablers* — how the Feature decomposes into stories/enablers (with story-point estimates when known). |
| `{{EXTERNAL_DEPENDENCIES}}` | no | *External dependencies* — vendors, partner teams, infra. Say `None.` if none. |
| `{{LEADING_INDICATORS}}` | no | *Leading indicators / OKRs* — how success is measured early (optional, but recommended). |

## Template body (Jira description, plain text)

```text
PROBLEM STATEMENT

{{PROBLEM_STATEMENT}}

BENEFIT HYPOTHESIS

{{BENEFIT_HYPOTHESIS}}

SCOPE

{{SCOPE}}

NON-FUNCTIONAL REQUIREMENTS

{{NON_FUNCTIONAL_REQUIREMENTS}}

ACCEPTANCE CRITERIA

{{ACCEPTANCE_CRITERIA}}

KEY MILESTONES & ENABLERS

{{MILESTONES_ENABLERS}}

EXTERNAL DEPENDENCIES

{{EXTERNAL_DEPENDENCIES}}

LEADING INDICATORS / OKRS

{{LEADING_INDICATORS}}
```

## Notes for the filling-in agent

- **Summary is a label, not a sentence.** ≤72 chars (boards truncate). A `[Feature]` prefix
  is optional but useful under Option C, where the Feature shares the Epic type with larger
  initiatives.
- **Choose the container, then publish.** pi-stef next-gen projects (`PISTFIN`-style:
  `PISTFIN`, `PISTQWE`, …) have **no separate Feature type** — **Option C is the default**:
  publish the Feature body as an *enriched Epic* (`issueTypeName: "Epic"`); the Epic's
  goal/scope/AC/milestones are satisfied by *problem + hypothesis* / *scope* / *acceptance
  criteria* / *milestones & enablers*, and it decomposes into Stories → Sub-tasks (see
  `jira-epic.md` / `jira-story.md` / `jira-subtask.md`). **Option A** (a custom `Feature`
  type with `issueTypeName: "Feature"` + `fields.parent.key` to the parent Epic) is kept for
  teams that later adopt one. The body above is identical either way.
- **Publish mechanics.** `summary` → the `summary` param; the body above → the
  `description` param (plain text; the tool converts to ADF); everything else via the
  `fields` map. Substitute **every** `{{TOKEN}}` — never publish a raw placeholder.
- **The ADF limit (repo-specific).** `jira_create_issue` converts plain text via
  `plainTextToAdf()`, which only produces `paragraph` / `hardBreak` / `text` nodes — **no
  real headings, bullet lists, or bold**. That's why section headers are ALL-CAPS lines
  (visual dividers) and `- ` / `**` markers render as literal text. A blank line starts a
  new paragraph; a single newline is a line break within a paragraph. If a section genuinely
  needs real lists/headings/bold, build an ADF object and pass it through
  **`fields.description`** (the top-level `description` stringifies objects into one text
  node); see [`jira-story.md`](./jira-story.md) for the bold-header ADF pattern.
- **Non-functional requirements must be honest.** They're first-class in this template on
  purpose — list the real performance/security/accessibility/observability constraints. If
  there are genuinely none, say `None identified yet.` rather than dropping the section.
- **Acceptance criteria are outcome-focused.** Prefer Given/When/Then for behavioural specs;
  a checklist is fine for simpler outcomes. Each AC should map to something verifiable.
- **Benefit hypothesis is testable.** Phrase it so you can evaluate it after launch — it's
  the Feature's reason to exist, not boilerplate.
- **Recommended fields** (via `fields`): `priority.name` — `High` for a Phase-1 Epic,
  `Medium` for later phases; `fixVersions[].name` — the **phase/quarter release marker**
  (e.g. `P1`, `Q1`; create via `jira_create_version`); `assignee` — the owner via `accountId`;
  `labels[]` — `enhancement` + the phase tag `phase-N`; `components[].name` — the **package
  name** (e.g. `qwen-proxy`, `finance-api` — never generic `api`/`infra`/`docs`). Under
  Option A also set `fields.parent.key` to the parent Epic.
- **Links.** Same as Epics: Epic ↔ Confluence PRD (relationship `implemented by`; Jira REST
  remotelink, no MCP create-tool — fallback to description text + comment), external
  remotelinks (repos/upstream/docs), and `blocks` / `relates to` issue links.
- **External dependencies as links.** For cross-issue deps, create issue links (`blocks` /
  `relates to`) in addition to the prose summary here.
- **Verify after publishing** with `jira_get_issue` (or `jira_issue`): confirm the summary,
  description, parent, and fields all landed.
