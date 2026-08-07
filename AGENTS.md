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

**How to use a template:**

1. Read the template `.md` and substitute **every** `{{TOKEN}}` — never publish a raw placeholder.
2. For Confluence templates, publish in **storage format** (`bodyRepresentation: "storage"`).
3. Keep the canonical section order and the live macros (e.g. `recently-updated`) intact; adapt the *content*, not the structure.
4. Verify after publishing (e.g. `confluence_page`) that the version incremented and the body replaced cleanly.

**Adding a new template:** create the `.md` under `docs/atlassian-templates/`, add a row to that folder's `README.md` table **and** to the table above, so future sessions can discover it.
