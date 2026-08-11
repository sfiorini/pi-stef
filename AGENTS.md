# Project Instructions — pi-stef

Rules every pi session must follow in this repository. Read in full at session start and apply in addition to any task-specific instructions.

## Releasing packages — `pnpm release` (maintainer-only)

Versioning, changelogs, tags, and npm publishing are fully automated by `pnpm release` (`scripts/release.mjs`), which the **maintainer** runs interactively. The flow:

1. Prompts for a package (or "all") and a bump type — patch / minor / major.
2. Bumps `version` in `packages/<pkg>/package.json`.
3. Generates the `## [<new-version>]` entry in `packages/<pkg>/CHANGELOG.md` **automatically from commit subject lines** since the last `@pi-stef/<pkg>@<version>` tag.
4. Commits `release(<pkg>): v<version>` (or `release(all): v<version>` for an all-packages release), tags `@pi-stef/<pkg>@<version>`, and pushes the commit + tag.
5. The tag push triggers `.github/workflows/publish.yml`, which publishes to npm.
6. Pre-flight gates: a clean working tree, the branch in sync with `origin`, and the full `pnpm test` passing.

Because the release tool owns all of the above, as an agent you must:

- **Never change the `version` field** in any `packages/*/package.json` — no pre-bumps, no "prepare for release," no version edits as part of a feature. Leave it untouched; the maintainer bumps it at release time. (Other `package.json` fields — dependencies, scripts, exports — are fine to edit.) When **creating a new package**, set `version` to `"0.0.0"` — the release tool bumps it on first release. (No need to create a `CHANGELOG.md`; the release tool creates it on first release.)
- **Never edit `packages/*/CHANGELOG.md`** — the release tool generates it from commits, so hand-edits get duplicated or orphaned. That means no `## [version]` headings, no content under `## [Unreleased]`, and no subsections under released entries. (The only exception: correcting a factual error in an already-released entry.)
- **Never run `pnpm release`**, and never create `@pi-stef/*@*.*.*` tags or run `npm publish` — these publish to npm and are maintainer-only.
- **Do write clear conventional-commit subject lines** — `feat(<scope>):`, `fix(<scope>):`, `docs:`, `chore:`, `refactor:` … — because each subject becomes a changelog bullet (only subjects are captured, not bodies). Signal breaking changes in the subject (e.g. `feat(<scope>)!:`).

If a task seems to require a version bump or a changelog edit, **do not make it** — flag it and point the maintainer to `pnpm release`, which owns both. This is a hard rule: don't edit versions or changelogs even when asked to.

## Atlassian templates — `docs/atlassian-templates/`

Reusable, source-controlled templates for the Confluence spaces and Jira content this project publishes. Each template is a self-documenting `.md` (purpose → placeholders → ready-to-use body). Check here **before** hand-writing a new space home page or page layout from scratch.

**Location:** [`docs/atlassian-templates/`](./docs/atlassian-templates) — start at its [`README.md`](./docs/atlassian-templates/README.md) for the index and conventions.

**Templates available today:**

| Template | File | Target / tool | Use it when… |
| --- | --- | --- | --- |
| Confluence space home page | [`confluence-space-homepage.md`](./docs/atlassian-templates/confluence-space-homepage.md) | `confluence_update_page` / `confluence_create_page` (storage format) | Creating a new project/product space or replacing an empty/stale home page. Gives a consistent hero, architecture, key-resources, quick-reference, and a live "recently updated" feed. |
| Confluence PRD | [`confluence-prd.md`](./docs/atlassian-templates/confluence-prd.md) | `confluence_create_page` / `confluence_update_page` (storage format) | Starting a new product phase or major feature. Captures problem, goals/non-goals, requirements, design, roadmap, risks, success criteria, open questions, and references. File under a per-product "PRD & Research" parent with the source research as siblings. |
| Jira Epic | [`jira-epic.md`](./docs/atlassian-templates/jira-epic.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | Starting a large, multi-sprint body of work that groups Stories toward one outcome. Captures goal/value, scope, out-of-scope, Epic-level acceptance criteria, milestones, dependencies, and references. |
| Jira Feature | [`jira-feature.md`](./docs/atlassian-templates/jira-feature.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | Shaping a mid-tier shippable increment (SAFe framing) with a benefit hypothesis, NFRs, and outcome-focused acceptance criteria. Used as an enriched Epic body (recommended) or a custom Feature type. |
| Jira Story | [`jira-story.md`](./docs/atlassian-templates/jira-story.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | Writing a sprint-sized unit of user value. Summary carries "As a / I want / so that"; body has context, testable acceptance criteria, and design/technical notes. |
| Jira Sub-task | [`jira-subtask.md`](./docs/atlassian-templates/jira-subtask.md) | `jira_create_issue` / `jira_update_issue` (plain-text description → ADF) | Breaking a Story into ≤1-day implementation slices. Imperative summary ("Add …"), parent = the Story, `Medium` priority. |

**How to use a template:**

1. Read the template `.md` and substitute **every** `{{TOKEN}}` — never publish a raw placeholder.
2. Publish in the right format: Confluence templates in **storage format**
   (`bodyRepresentation: "storage"`); Jira templates either as **plain text** to the
   top-level `description` (converted to ADF automatically — no bold/lists/inline-code) or,
   for rich formatting (bold section headers, bullet lists, inline code), as a pre-built
   **ADF object via `fields.description`** (the top-level `description` arg stringifies
   objects, so pass ADF through `fields.description`). See
   [`docs/atlassian-templates/jira-story.md`](./docs/atlassian-templates/jira-story.md) for
   the bold-header ADF pattern.
3. Keep the canonical section order and the live macros (e.g. `recently-updated`) intact; adapt the *content*, not the structure.
4. Verify after publishing (`confluence_page` for Confluence pages, `jira_get_issue` for
   Jira issues) that the content landed cleanly (version incremented / body replaced).

**Adding a new template:** create the `.md` under `docs/atlassian-templates/`, add a row to that folder's `README.md` table **and** to the table above, so future sessions can discover it. When a new Jira template changes the field conventions (components, labels, fix-versions, priority, hierarchy), reflect that change here in *Jira backlog conventions* and in the `PISTFIN` reference project.

## Jira backlog conventions

When standing up a Jira backlog for a package, **mirror `PISTFIN`** (`@pi-stef/finance-api`) — it is the canonical example project. New package backlogs (e.g. `PISTQWE` for `@pi-stef/qwen-proxy`) replicate its structure exactly.

- **Hierarchy:** `Epic → Story → Sub-task`. Next-gen (team-managed) projects use **no separate `Feature` type**; publish the `jira-feature.md` template as an enriched Epic (Option C) when a benefit-hypothesis shape is wanted.
- **Epics carry an execution-order table.** Every Epic description includes an `Order | Story | Milestone | Blocked by | Blocks` ADF table (mark parallel milestones `∥`), derived from its Stories' `Blocks` links (`inwardIssue`=prereq/blocker, `outwardIssue`=dependent) — see [`jira-epic.md`](./docs/atlassian-templates/jira-epic.md).
- **Fields (every issue):**
  - `components[]` = the **package name** (`qwen-proxy`, `finance-api`, `paths`) — never generic `api`/`infra`/`docs`.
  - `labels[]` = `enhancement` + the phase tag `phase-N` (e.g. `phase-1`), plus optional topic tags.
  - `fixVersions[]` = the phase/quarter release marker (`P1`, `Q1`, …); create it first via `jira_create_version` if missing.
  - `priority` = `High` for Phase-1 issues, `Medium` for later phases; **Sub-tasks default `Medium`** regardless of parent.
  - `assignee` = the package owner (DRI) via `accountId`.
  - Sub-tasks: imperative summary (`Add …`, `Implement …`, `Wire …`), parent = Story, **1-line description**. Use [`jira-subtask.md`](./docs/atlassian-templates/jira-subtask.md).
- **Links:**
  - **Story ↔ Story `Blocks`** for the dependency graph — `jira_create_issue_link typeName: "Blocks"`, `outwardIssueKey` = dependent, `inwardIssueKey` = prerequisite (the prereq blocks the dependent — verified for the @pi-stef tool; re-verify if you switch Jira clients).
  - **Epic ↔ Confluence PRD** (relationship `implemented by`) — via the Jira REST remotelink API (there is no MCP create-tool); fallback = embed the PRD title + page id in the Epic description + a comment.
  - **External remotelinks** (GitHub repo, upstream host, API docs, reference repos) attached at the Epic level with explicit relationship labels.
- **Publishing order:** `Q1`/version → Epic (capture key) → Stories (parent = Epic) → Sub-tasks (parent = Story) → Blocks links → Confluence/external links → verify with `jira_get_issue`.
- See [`docs/atlassian-templates/`](./docs/atlassian-templates) (incl. `jira-subtask.md`) and the `PISTFIN` project for a worked example.
