# Atlassian Templates

Reusable templates for content we publish to Atlassian Cloud (Confluence spaces/pages,
Jira issue types, etc.). Each template is a self-documenting Markdown file containing:

- **What it's for** — the use case and when to apply it.
- **Placeholders** — every `{{TOKEN}}` the template exposes, with a description.
- **Template body** — the ready-to-use content in a fenced code block: Confluence
  *storage format* XHTML for Confluence templates, plain text (converted to ADF) for Jira
  templates. Copy it, substitute the placeholders, and push it through the matching tool.

## Available templates

| Template | File | Tool / target | Purpose |
| --- | --- | --- | --- |
| Confluence space home page | [`confluence-space-homepage.md`](./confluence-space-homepage.md) | `confluence_update_page` (or `confluence_create_page`) | The landing page for a project/product space. Gives visitors the elevator pitch, architecture, key resources, a quick-reference, and a live "recently updated" feed in one consistent layout. |
| Confluence PRD | [`confluence-prd.md`](./confluence-prd.md) | `confluence_create_page` / `confluence_update_page` (storage format) | A new product phase or major feature. Captures problem, goals/non-goals, requirements, design, roadmap, risks, success criteria, open questions, and references. File under a per-product "PRD & Research" parent with the source research as siblings. |
| Jira Epic | [`jira-epic.md`](./jira-epic.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | A large, multi-sprint body of work. Captures goal & value, scope, out-of-scope, Epic-level acceptance criteria, rollout milestones, dependencies, and references. |
| Jira Feature | [`jira-feature.md`](./jira-feature.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | A mid-tier shippable increment (SAFe framing). Carries a benefit hypothesis, NFRs, outcome-focused acceptance criteria, milestones, and OKRs. Used as an enriched Epic body (recommended) or a custom Feature type. |
| Jira Story | [`jira-story.md`](./jira-story.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | A sprint-sized unit of user value. Summary carries the "As a / I want / so that"; body has context, testable acceptance criteria, design/technical notes, and a suggested breakdown. |
| Jira Sub-task | [`jira-subtask.md`](./jira-subtask.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | A ≤1-day implementation slice that breaks a Story into verifiable steps. Imperative summary ("Add …"), parent = the Story, `Medium` priority. |

## Conventions

- **One file per template.** Keep the template, its placeholder docs, and a filled-in
  example (when useful) together in a single `.md` so an agent can read one file and act.
- **Storage format for Confluence.** Confluence templates are authored in *storage format*
  (the XHTML + macro dialect the REST API accepts). When publishing, pass
  `bodyRepresentation: "storage"` to `confluence_update_page` / `confluence_create_page`.
- **Plain text → ADF for Jira.** Jira templates are authored as plain text (the ```text
  body is the issue `description`); `jira_create_issue` / `jira_update_issue` convert it to
  Atlassian Document Format automatically. The converter only makes paragraph / line-break /
  text nodes — no real headings, lists, or bold — so Jira template bodies use ALL-CAPS
  section headers as visual dividers. For rich formatting, pass a pre-built ADF object as
  the `description`.
- **PISTFIN Jira conventions.** pi-stef Jira projects (`PISTFIN`, `PISTQWE`, …) use a
  three-tier **Epic → Story → Sub-task** hierarchy with **no separate Feature type**
  (Feature bodies are enriched Epics — see `jira-feature.md`); `components[]` = the package
  name; `labels[]` = `enhancement` + `phase-N`; `fixVersions[]` = the phase/quarter marker
  (`P1`/`Q1`); priority `High` (phase 1) / `Medium` (later) / `Medium` (sub-tasks); Story
  dependencies via `Blocks` issue links; each Epic links its Confluence PRD.
- **Placeholders use `{{UPPER_SNAKE}}`.** Substitute every token before publishing; never
  publish a raw placeholder.
- **Preserve the section order.** The section order in each template is the canonical
  layout. Adapt the *content* of a section to the space, but keep the ordering and the
  macros (e.g. the live `recently-updated` feed) intact so every home page looks familiar.
- **Adding a template:** add the `.md` file here, then add a row to the table above and a
  bullet to `AGENTS.md` → *Atlassian templates* so future sessions can discover it.
