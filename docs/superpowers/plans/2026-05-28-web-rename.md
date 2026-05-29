# Web Package Rename & Tool Namespace Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `web-access` package to `web` (@pi-stef/web), change tool names from `fh_web_*` to `web_*`, and fix `--scope` in install docs across all packages.

**Architecture:** Directory rename + systematic sed passes across source, tests, docs, and root config. No code generation — pure rename.

**Tech Stack:** TypeScript, pnpm workspaces, vitest

---

## Milestone M1: Rename web-access → web (directory + package identity)

### Task M1-S1: Rename directory and update package.json

**Files:**
- Rename: `packages/web-access/` → `packages/web/`
- Modify: `packages/web/package.json`

- [ ] **Step 1: Rename the directory**

```bash
mv packages/web-access packages/web
```

- [ ] **Step 2: Update package.json name**

In `packages/web/package.json`, change:
```json
"name": "@pi-stef/web-access"
```
to:
```json
"name": "@pi-stef/web"
```

Also update keywords — replace `"web-access"` with `"web"`:
```json
"keywords": [
    "pi-package",
    "pi-extension",
    "web",
    "web-search",
    "web-fetch",
    "cloakbrowser",
    "browser-automation"
]
```

- [ ] **Step 3: Verify file structure**

```bash
find packages/web -type f | wc -l
```

Expected: same count as before the rename (~45 files).

- [ ] **Step 4: Rename extension file**

```bash
mv packages/web/extensions/web-access.ts packages/web/extensions/web.ts
```

The `pi.extensions` config uses `"./extensions"` which resolves via directory glob, so the new filename is discovered automatically.

- [ ] **Step 5: Update extension import in tests**

```bash
sed -i '' 's/extensions\/web-access/extensions\/web/g' packages/web/tests/*.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/web-access/ packages/web/
git commit -m "refactor: rename web-access package directory to web"
```

---

## Milestone M2: Rename tool names fh_web_* → web_* in source

### Task M2-S1: Rename tool names in tools.ts

**Files:**
- Modify: `packages/web/src/tools.ts`

- [ ] **Step 1: Replace all fh_web_ with web_ in tools.ts**

```bash
sed -i '' 's/fh_web_/web_/g' packages/web/src/tools.ts
```

This covers all 5 tool registrations (`name: "web_search"`, etc.), all prompt snippets, and all usage messages.

Also replace bare `web-access` references in description strings and slash-command help text:

```bash
sed -i '' 's/web-access/web/g' packages/web/src/tools.ts
```

This updates command descriptions like `"Manage web-access: /web status|sessions|clear-session"` and usage strings.

- [ ] **Step 2: Verify — check for remaining fh_web_**

```bash
grep -n 'fh_web_' packages/web/src/tools.ts
```

Expected: 0 matches.

- [ ] **Step 3: Verify no stale web-access refs in tools.ts**

```bash
grep -n 'web-access' packages/web/src/tools.ts
```

Expected: 0 matches.

- [ ] **Step 4: Verify new names**

```bash
grep -n 'name: "web_' packages/web/src/tools.ts
```

Expected: 5 matches (web_search, web_fetch, web_flow, web_login, web_session).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/tools.ts
git commit -m "refactor: rename fh_web_* tools to web_* and web-access → web in tools.ts"
```

### Task M2-S2: Rename tool names in test files

**Files:**
- Modify: `packages/web/tests/extensionRegistration.test.ts`
- Modify: `packages/web/tests/toolWiring.test.ts`
- Modify: `packages/web/tests/tools.e2e.test.ts`

- [ ] **Step 1: Replace fh_web_ with web_ and web-access with web in all test files**

```bash
find packages/web/tests -name '*.ts' -exec sed -i '' 's/fh_web_/web_/g; s/web-access/web/g' {} +
```

This also updates `describe("web-access search", ...)` blocks, `import webAccessExtension from "../extensions/web-access"` (now `../extensions/web`), and temp paths like `/tmp/sf-web-smoke`.

- [ ] **Step 2: Verify**

```bash
grep -rn 'fh_web_' packages/web/tests/ --include="*.ts"
```

Expected: 0 matches.

- [ ] **Step 3: Commit**

```bash
git add packages/web/tests/
git commit -m "refactor: rename fh_web_* to web_* in test files"
```

---

## Milestone M3: Update cross-package references to @pi-stef/web

### Task M3-S1: Update sf-team dependency and imports

**Files:**
- Modify: `packages/sf-team/package.json`
- Modify: `packages/sf-team/src/research/default-fetcher.ts`
- Modify: `packages/sf-team/src/research/types.ts`
- Modify: `packages/sf-team/src/research/external-fetch.ts`
- Modify: `packages/sf-team/src/register.ts`

- [ ] **Step 1: Update sf-team package.json dependency path**

In `packages/sf-team/package.json`, change:
```json
"@pi-stef/web-access": "file:../web-access"
```
to:
```json
"@pi-stef/web": "file:../web"
```

- [ ] **Step 2: Update import in default-fetcher.ts**

In `packages/sf-team/src/research/default-fetcher.ts`, change:
```typescript
} from "@pi-stef/web-access";
```
to:
```typescript
} from "@pi-stef/web";
```

- [ ] **Step 3: Update comments referencing @pi-stef/web-access**

```bash
sed -i '' 's/@pi-stef\/web-access/@pi-stef\/web/g; s/web-access docs/web docs/g' packages/sf-team/src/research/types.ts packages/sf-team/src/research/external-fetch.ts packages/sf-team/src/research/default-fetcher.ts packages/sf-team/src/register.ts
```

- [ ] **Step 4: Verify**

```bash
grep -rn 'web-access' packages/sf-team/ --include="*.ts" --include="*.json"
```

Expected: 0 matches.

- [ ] **Step 5: Commit**

```bash
git add packages/sf-team/
git commit -m "refactor: update sf-team imports from @pi-stef/web-access to @pi-stef/web"
```

### Task M3-S2: Update root config files

**Files:**
- Modify: `tsconfig.json`
- Modify: `scripts/install-all.sh`
- Modify: `README.md`

- [ ] **Step 1: Update root tsconfig.json**

In `tsconfig.json`, change:
```json
{ "path": "packages/web-access" }
```
to:
```json
{ "path": "packages/web" }
```

- [ ] **Step 2: Update install-all.sh**

In `scripts/install-all.sh`, change:
```bash
PACKAGES=("superpowers-adapter" "agent-workflows" "atlassian" "figma" "sf-team" "web-access")
```
to:
```bash
PACKAGES=("superpowers-adapter" "agent-workflows" "atlassian" "figma" "sf-team" "web")
```

- [ ] **Step 3: Update root README**

In `README.md`, change the web-access row:
```markdown
| [web-access](packages/web-access/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install git:github.com/<USER>/pi-stef#packages/web-access` |
```
to:
```markdown
| [web](packages/web/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install git:github.com/<USER>/pi-stef#packages/web` |
```

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json scripts/install-all.sh README.md
git commit -m "refactor: update root config from web-access to web"
```

---

## Milestone M4: Fix web package README (install commands + tool names)

### Task M4-S1: Update web README

**Files:**
- Modify: `packages/web/README.md`

- [ ] **Step 1: Replace all fh_web_ with web_ and web-access with web in README**

```bash
sed -i '' 's/fh_web_/web_/g; s/web-access/web/g' packages/web/README.md
```

This also updates `@pi-stef/web-access` → `@pi-stef/web`, install commands (`pi install ...packages/web-access` → `...packages/web`), usage examples (`pi "Use web-access to...` → `pi "Use web to...`), file paths (`cd packages/web-access` → `cd packages/web`), and test runner paths.

- [ ] **Step 2: Verify tool name tables**

```bash
grep 'web_search\|web_fetch\|web_flow\|web_login\|web_session' packages/web/README.md | wc -l
```

Expected: ~18 matches (table rows, usage examples, parameter tables, security note).

- [ ] **Step 3: Verify no fh_web_ remains**

```bash
grep 'fh_web_' packages/web/README.md
```

Expected: 0 matches.

- [ ] **Step 4: Commit**

```bash
git add packages/web/README.md
git commit -m "docs: update web README tool names from fh_web_* to web_*"
```

---

## Milestone M5: Fix --scope in figma and sf-team READMEs

### Task M5-S1: Fix figma README install commands

**Files:**
- Modify: `packages/figma/README.md`

- [ ] **Step 1: Find and fix the --scope lines**

At line 58 and 64, the install commands use `--scope` which doesn't exist for `pi install`. Replace:

Line 58 context:
```text
pi install figma --scope project
```
→
```text
pi install git:github.com/<USER>/pi-stef#packages/figma
```

Line 64 context (if present):
```text
pi install figma --scope project --dry-run
```
→
```text
pi install -l git:github.com/<USER>/pi-stef#packages/figma
```

Apply via sed:
```bash
sed -i '' 's/pi install figma --scope project/pi install git:github.com\/<USER>\/pi-stef#packages\/figma/g; s/pi install figma --scope project --dry-run/pi install -l git:github.com\/<USER>\/pi-stef#packages\/figma/g' packages/figma/README.md
```

- [ ] **Step 2: Verify**

```bash
grep -n '--scope' packages/figma/README.md
```

Expected: 0 matches.

- [ ] **Step 3: Commit**

```bash
git add packages/figma/README.md
git commit -m "docs: fix figma README install commands (--scope does not exist)"
```

### Task M5-S2: Fix sf-team README install command

**Files:**
- Modify: `packages/sf-team/README.md`

- [ ] **Step 1: Fix the --scope line**

At line 703:
```text
scripts/pi install sf-team --scope project
```
→
```text
scripts/pi install sf-team
```

Apply via sed:
```bash
sed -i '' 's/scripts\/pi install sf-team --scope project/scripts\/pi install sf-team/' packages/sf-team/README.md
```

- [ ] **Step 2: Verify**

```bash
grep -n '--scope' packages/sf-team/README.md
```

Expected: 0 matches.

- [ ] **Step 3: Commit**

```bash
git add packages/sf-team/README.md
git commit -m "docs: fix sf-team README install command (--scope does not exist)"
```

---

## Milestone M6: Install, typecheck, and test

### Task M6-S1: Install dependencies and verify

- [ ] **Step 1: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 2: Verify lockfile has updated path**

```bash
grep 'packages/web:' pnpm-lock.yaml | head -3
```

Expected: `packages/web:` present, no `packages/web-access:`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes. If errors, fix import paths or tsconfig references.

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

Expected: all tests pass. The web package tests should now reference `web_*` tool names.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve typecheck/test issues after web package rename"
```

### Task M6-S2: Final grep verification

- [ ] **Step 1: Verify zero fh_web_ references**

```bash
grep -rn 'fh_web_' packages/ --include="*.ts" --include="*.md" --include="*.json" | grep -v node_modules
```

Expected: 0 matches.

- [ ] **Step 2: Verify zero web-access references in source/docs (excluding runtime config paths)**

```bash
grep -rn 'web-access' packages/ --include="*.ts" --include="*.json" --include="*.md" | grep -v node_modules | grep -v '\.pi.*web-access\|sf-web-access\|web-access-'
```

Note: Runtime config paths (`~/.pi/web-access/` in `src/config.ts`) and temp dir prefixes (`sf-web-access-*` in tests) intentionally keep the old name to avoid orphaning existing user data. The grep excludes these patterns.

- [ ] **Step 3: Verify zero --scope references in install docs**

```bash
grep -rn 'pi install.*--scope' packages/ --include="*.md"
```

Expected: 0 matches.

- [ ] **Step 4: Verify root README lists web (not web-access)**

```bash
grep 'web' README.md | head -3
```

Expected: row with `[web](packages/web/README.md)`.

---

## Execution Rules

- Run typecheck/tests after each milestone.
- Commit locally after each milestone (**do not push**).
- Each milestone commit serves as a rollback point.

**Note on pnpm-lock.yaml:** After `pnpm install` in M6-S1, the lock file will be updated. It should be committed together with any M6 fixes.
