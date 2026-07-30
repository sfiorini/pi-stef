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
