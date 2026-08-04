# Continuation runbook — {{slug}}

> Read FIRST on resume, then work from `original-plan.md` and `story-tracker.md`.

## Quick Resume
1. Read this runbook.
2. Check `story-tracker.md` for the next `pending` story; mark it `in-dev`.
3. Implement per `original-plan.md`; run typecheck + tests; mark `completed` with the commit SHA.
4. Commit locally (do not push) after each milestone; advance the tracker.

## Context
- **Goal:** <!-- one line -->
- **Slug:** `{{slug}}`

## Verification
- Typecheck: `pnpm --filter @pi-stef/flow typecheck`
- Tests: `npx vitest run packages/flow/tests` (run from the workspace root)
