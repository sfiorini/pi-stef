# Design: Codebase Remediation Plan

**Date:** 2026-06-03
**Source:** Merged findings from two independent code reviews (151 items)
**Approach:** Priority × Package Hybrid (Approach C)

---

## Goal

Address all 151 findings from the merged code review across 8 packages in the pi-stef monorepo. Organized into 10 milestones that proceed from critical fixes through per-package deep-dives to a final polish sweep.

## Design Principles

- **Each milestone is independently testable** — lint, typecheck, and tests pass after every milestone.
- **Commit per milestone** — no pushes until user approves.
- **Stories are 2-5 minute units** — small enough to verify incrementally.
- **Dead code removal before refactoring** — don't refactor code you're about to delete.
- **DRY extraction after dead code cleanup** — cleaner diff, fewer conflicts.

## Milestone Overview

| MS | Title | Items | Effort | Key Deliverables |
|----|-------|-------|--------|------------------|
| M1 | P0 Critical Fixes + Root Config | 12 | S-M | Fix parseWorkflowMetadata mutation, wire catalog LLM tools, clean pnpm-workspace.yaml |
| M2 | Cross-Cutting Enablers | 8 | S-M | Enable strict TS in 4 packages, add license/files/scripts to all packages |
| M3 | agent-workflows Deep-Dive | 10 | M-L | Fix fs race conditions, mutable state, add tests for verification/resume/orchestrator |
| M4 | catalog Deep-Dive | 16 | M | Fix sync atomicity, DRY execFile wrappers, wire isValidSource, fix stub suggestions |
| M5 | team Deep-Dive | 18 | M-L | Empty catch blocks, dead code (spike.ts), file splits, cost counting, DRY helpers |
| M6 | atlassian Deep-Dive | 15 | M | Type safety, DRY utilities, dead exports, shared ExecuteFn/register helper |
| M7 | figma Deep-Dive | 18 | M-L | Unify HTTP clients, remove dead schemas, add tests, fix duplicate errors |
| M8 | web Deep-Dive | 14 | M | JSDOM memory leaks, DRY utilities, singleton TurndownService, type safety |
| M9 | superpowers-adapter Deep-Dive | 10 | S-M | Remove dead Task tool, fix README inaccuracies, sanitize Task tool input |
| M10 | P3 Polish Sweep | 29 | S-M | Barrel exports, AI-slop comments, test consolidation, minor cleanups across all packages |

---

## M1: P0 Critical Fixes + Root Config Cleanup

Fixes 4 P0 issues and 4 root-config P1 issues. Everything here is trivial-to-small effort.

**Stories:**
- S11: Fix `parseWorkflowMetadata` input mutation — spread into new object
- S12: Add enum validation to `parseWorkflowMetadata` — validate `typeof schemaVersion === "number"` and enum fields
- S13: Fix `runWorkflow` return type — use discriminated union instead of `undefined as TResult`
- S14: Wire catalog LLM tool stubs to actual command implementations
- S15: Remove corrupted `allowBuilds` block from `pnpm-workspace.yaml`
- S16: Remove stale `@google/genai` and `protobufjs` from `onlyBuiltDependencies`
- S17: Fix `sf-team` → `team` in install script (or delete deprecated script)
- S18: Remove deprecated install scripts from root `package.json`
- S19: Add `"license": "MIT"` to all 7 package.json files missing it
- S1A: Bump all packages to `0.2.0` — project has matured past `0.1.0`
- S1B: Add `files` field to 6 package.json files
- S1C: Add `test`/`typecheck` scripts to 5 packages missing them

**Validation:** `pnpm typecheck && pnpm test` pass. All existing tests green.

---

## M2: Cross-Cutting Enablers

Enable strict TypeScript checks and fix the resulting dead code. This is a prerequisite for later milestones — catching unused code now prevents refactoring dead code later.

**Stories:**
- S21: Enable `noUnusedLocals`/`noUnusedParameters` in `agent-workflows/tsconfig.json`, fix errors
- S22: Enable `noUnusedLocals`/`noUnusedParameters` in `team/tsconfig.json`, fix errors
- S23: Enable `noUnusedLocals`/`noUnusedParameters` in `figma/tsconfig.json`, fix errors
- S24: Enable `noUnusedLocals`/`noUnusedParameters` in `web/tsconfig.json`, fix errors
- S25: Remove `.gitignore` blanket `*.js` rule — replace with targeted exclusions
- S26: Remove `.gitignore` entry for non-existent `docs/superpowers/`
- S27: Fix 4 catalog typecheck errors (TS2345 in test mocks)
- S28: Standardize barrel export style to named exports across all packages

**Validation:** `pnpm typecheck && pnpm test` pass with strict checks enabled.

---

## M3: agent-workflows Deep-Dive

Fix runtime correctness issues and add test coverage for the foundational library.

**Stories:**
- S31: Fix `plan-index.ts` — use async `fs/promises` with serialization for `upsertEntry`
- S32: Fix `plan-index.ts` — store normalized root (not raw) to prevent duplicate entries
- S33: Fix `checkpoint-runtime.ts` — unify sync/async I/O paths, document constraint
- S34: Fix `checkpoint-runtime.ts` — stop queue from swallowing errors (`.catch(() => undefined)`)
- S35: Replace `nextGeneratedId` mutable counter with `crypto.randomUUID()`
- S36: Fix `resolve-plan-target.ts` — use `WORKFLOW_METADATA_FILE` constant
- S37: Fix `parseCheckpointStore` — return defensive copy
- S38: Document TOCTOU race in `sweepStaleLockDirs` with inline comment
- S39: Replace `!` non-null assertions in `reporter.ts` with proper null checks
- S3A: Add tests for `verification/`, `resume/`, `orchestrator/` modules (at least 1 test file per module)

**Validation:** `pnpm test --filter @pi-stef/agent-workflows` passes. New tests cover verification, resume, orchestrator.

---

## M4: catalog Deep-Dive

Fix sync atomicity, DRY violations, and correctness issues.

**Stories:**
- S41: Fix `syncCommand` atomicity — pull to memory, reconcile, write only on success
- S42: Fix `Octokit` fallback — pass token or remove fallback
- S43: Fix `statusCommand` — use `resolveEffectivePackages` for profile filtering
- S44: Fix `formatUserError` — remove or implement `--offline` flag suggestion
- S45: Unify `isValidSource` — single implementation covering all formats
- S46: Extract shared `execCommand` from 3 wrappers (update/registry, sync/auth, sync/gist)
- S47: Deduplicate `self-update.ts` + `pi-update.ts` — extract shared core, parameterize cache key and package name
- S48: Fix `contentHash` — hash content (not source string) or rename field
- S49: Fix `cleanGitName` — handle multiple colons explicitly
- S4A: Fix `readPackagesFromSettings` — don't silently swallow malformed JSON
- S4B: Fix `cloneCatalog` — use structured clone or document shallow-clone constraint
- S4C: Export `ProfileSchema` from barrel
- S4D: Document `parseSubcommand` flag-before-subcommand behavior
- S4E: Remove or verify unused `resolveEffectivePackages` in sync/reconcile
- S4F: Split `register.ts` (944 lines) — extract schema definitions, cost-summary formatting into separate modules
- S4G: Remove verbose barrel-file comment from `catalog/src/index.ts`

**Validation:** `pnpm test --filter @pi-stef/catalog` passes. Catalog LLM tools work end-to-end.

---

## M5: team Deep-Dive

The largest milestone. Address error handling, dead code, and file organization.

**Stories:**
- S51: Add structured logging to all 60+ empty catch blocks (prioritize spawn.ts, run.ts)
- S52: Fix `parseMarkdownTokenUsage` — set `unknownCostCount=0` when cost is known
- S53: Delete `runtime/spike.ts` and `tests/spike-isolation.test.ts`
- S54: Remove unused `createTranscript` and `scanExistingMaxSeq` from `transcript.ts`
- S55: Trim AI-slop comments in `errors.ts` — remove 27-line file header, verbose JSDoc
- S56: Extract `isRecord` helper to shared utility, remove 4 independent definitions
- S57: Deduplicate `parseLineDelimitedJson` and `extractFinalAssistantText`/`extractVerdict`
- S58: Remove re-declared `CloneOverrides` in `empty-plan-error.ts`, import from `errors.ts`
- S59: Deduplicate `DEFAULT_CONFIG` — keep JSON as source of truth, import in TS
- S5A: Fix shallow spread for nested `verification` config — deep merge
- S5B: Reduce `any` casts on schema parameters in `register.ts`
- S5C: Split `implement.ts` (1,972 lines) into per-phase modules
- S5D: Split `plan.ts` (1,852 lines) into per-phase modules
- S5E: Split `shared.ts` (925 lines) — extract helper functions
- S5F: Reduce inline "what" comments across `register.ts`, `run.ts`, `shared.ts`
- S5G: Verify/remove `resolveValueSync` if unused
- S5H: Remove pure re-export barrels `plan/paths.ts` and `plan/lock.ts` (import directly from agent-workflows)
- S5I: Remove weak test files (1-2 assertions) or expand them

**Validation:** `pnpm test --filter @pi-stef/team` passes. No empty catch blocks remain without logging.

---

## M6: atlassian Deep-Dive

Type safety and DRY cleanup.

**Stories:**
- S61: Extract shared `src/internal/helpers.ts` — `asRecord`, `getString`, `getNumber`, `decodeHtml`
- S62: Extract shared `src/tools/types.ts` — unified `ExecuteFn` type
- S63: Extract shared `src/tools/register.ts` — unified `register()` helper
- S64: Replace `any` types in tool signatures with `Record<string, unknown>` or generics
- S65: Fix `pickContextOptions` — type the 20-property destructure properly
- S66: Remove unused `CursorPage`, `getNextCursor` exports
- S67: Remove unused re-exports: `getStoryContext` alias, `plainTextToAdf`
- S68: Remove unused `endpointVerification.ts` (entire file) or move to docs
- S69: Fix `request()` return type — proper discriminated union for 204/empty
- S6A: Rename `batchCreateVersions` to `createVersionsSequentially` or implement actual batching
- S6B: Add security-intent comment to path traversal check
- S6C: Deduplicate `RecordingHttp` test helper across 3 test files
- S6D: Deduplicate `unique()` implementations
- S6E: Fix boolean query params — explicit string conversion

**Validation:** `pnpm test --filter @pi-stef/atlassian` passes. No `any` in tool signatures.

---

## M7: figma Deep-Dive

HTTP client unification, dead code removal, and test coverage.

**Stories:**
- S71: Consolidate `FigmaApiError` — single class, import in both modules
- S72: Unify HTTP clients — make `FigmaApi` a facade over `FigmaClient` or remove it
- S73: Instantiate `FigmaClient` once at extension setup, reuse across calls
- S74: Add Zod response validation for critical `FigmaClient` endpoints
- S75: Remove ~300 lines of dead schemas from `schemas.ts`
- S76: Remove dead branch in `FigmaNodeParser.ts` (both if/else identical)
- S77: Remove `extractText` dead method
- S78: Consolidate `hasImageFill` — single definition
- S79: Consolidate URL parsing — single strategy from `url.ts`
- S7A: Consolidate `FIGMA_API_BASE` constant — define once
- S7B: Fix `downloadImageUrls` — pass AbortSignal through
- S7C: Simplify abort/signal wiring with `AbortSignal.any()`
- S7D: Fix opaque `unknown` return in `filterLibraryItems`
- S7E: Fix config caching — don't create new auth instance per call
- S7F: Resolve duplicate-tool-detection TODO — check for typed error or add test
- S7G: Add tests for `transform/` modules (pure functions, highest ROI)
- S7H: Add tests for `FigmaClient` error paths
- S7I: Trim verbose JSDoc comments across figma package

**Validation:** `pnpm test --filter @pi-stef/figma` passes. Test ratio improved from 0.1 to at least 0.5.

---

## M8: web Deep-Dive

Memory leaks, DRY, and type safety.

**Stories:**
- S81: Fix JSDOM memory leak — close windows in `extractHtmlContent`, add `withJSDOM` helper
- S82: Extract shared utilities — `cleanText`, `escapeRegExp`, `sleep` into `src/internal/utils.ts`
- S83: Consolidate sensitive key constants — define once in `config.ts`, import in `redact.ts`
- S84: Make `TurndownService` a singleton (module-level instance)
- S85: Replace hardcoded `sleep(1000)` with `page.waitForSelector` in cloak.ts
- S86: Fix duplicate case-insensitive regex `/enable javascript/i`
- S87: Fix `roleClick` — remove `never` cast, use proper type guard
- S88: Fix `mergeConfig` — deep merge for arrays instead of shallow `Object.assign`
- S89: Unexport `fetchGuardedText` (internal HTTP primitive)
- S8A: Fix `any` in command handler context parameters
- S8B: Replace `normalizeFlowSteps` internal-only export with non-exported function
- S8C: Add test for skipped test in `search.test.ts` or add tracking TODO
- S8D: Review `handleSessionAction` authorization — document current `yes` flag behavior
- S8E: Fix `parseFlowSteps` — continue on unrecognized step with warning instead of fail

**Validation:** `pnpm test --filter @pi-stef/web` passes. No JSDOM leaks.

---

## M9: superpowers-adapter Deep-Dive

Dead tool removal, README fixes, and security.

**Stories:**
- S91: Remove dead `Task` tool entirely (or delegate to Agent tool). If kept, S92 applies.
- S92: (Only if Task tool kept after S91) Fix LLM injection — sanitize user input before interpolation
- S93: Fix README skill discovery order to match actual code
- S94: Fix README frontmatter truncation — remove false limitation paragraph
- S95: Fix `findSkillsDirs` — add breadth limit, propagate EMFILE/ENOMEM errors
- S96: Fix `readSkillContent` — return error message instead of silent null
- S97: Consolidate two frontmatter regexes into one
- S98: Standardize error message prefixes across all files
- S99: Remove trivial `index.test.ts` assertions (2x `expect(true)`) — replace with real tests
- S9A: Fix README install URL placeholder `<USER>`

**Validation:** `pnpm test --filter @pi-stef/superpowers-adapter` passes.

---

## M10: P3 Polish Sweep

Remaining cosmetics and nice-to-haves across all packages.

**Stories:**
- SA1: Trim verbose JSDoc on `resolvePlanRoot` in agent-workflows
- SA2: Add `@deprecated` tags to legacy `planFolderPath` helpers
- SA3: Standardize test import style in agent-workflows (all from barrel or all direct)
- SA4: Fix `update-cache.ts` `as Record<string, unknown>` casts — use Zod output types
- SA5: Extract `MockUi` test helper to shared test utility in catalog
- SA6: Remove `CATALOG_INTEGRATION` env guard if I/O is fully mocked
- SA7: Fix `lineDiff` in catalog or document that it's not a real diff
- SA8: Fix `SfTeamExecuteFn` `any` for `onUpdate`/`ctx` in team
- SA9: Normalize comment dividers in team (`// ---- 2) section ----`)
- SAA: Verify team `package.json` runtime deps on `@pi-stef/figma` and `@pi-stef/web`
- SAB: Remove unused `os` import in `AtlassianAuth.ts`
- SAC: Replace `readFileSync` with async in atlassian auth
- SAD: Fix `URL_RE` regex — exclude trailing punctuation
- SAE: Deduplicate test fixtures in atlassian `cli.test.ts`
- SAF: Improve `htmlToMarkdown` to handle `<strong>`, `<em>`, `<img>` tags
- SAG: Add `bin` field to atlassian `package.json`
- SAH: Deduplicate `FakePi` test helper in figma
- SAI: Fix 3x `@ts-expect-error` for `StringEnum` type gap in figma
- SAJ: Remove redundant throw in Zod `.transform` in figma
- SAK: Document `compactNode` `maxDepth=4` default
- SAL: Replace `includes` dedup with `Set` in figma `collectRawText`
- SAM: Use `vi.stubEnv` instead of manual `process.env` restore in figma tests
- SAN: Fix `getFileVersion` to request minimal fields
- SAO: Deduplicate test helper in catalog (RecordingHttp pattern)
- SAP: Remove `normalizeFlowSteps` export or mark internal
- SAQ: Add config parsing unit tests in web
- SAR: Consolidate `isExistsOrNotEmpty` name or add clarifying comment
- SAS: Remove `endpointVerification.ts` if still present, or document purpose
- SAT: Update or remove stale `PROVENANCE.md` in figma

**Validation:** `pnpm typecheck && pnpm test` pass across all packages. Clean lint.

---

## Execution Rules

- Run `pnpm typecheck && pnpm test` after each milestone
- Commit locally after each milestone (do not push)
- Stop and ask for user feedback between milestones
- Apply feedback, rerun checks, commit again
- Move to next milestone only after user approval
- After all milestones complete and approved, ask permission to push

## Reviewer

- CLI: `codex`
- Model: `deepseek-v4-pro`
- Max rounds: 10
