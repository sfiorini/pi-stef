# SF-Team Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract fh-team and its 4 sibling dependencies from fh-agent into pi-stef as `@pi-stef/*` packages, rename all fh/first-horizon references, and fix the pi API namespace in superpowers-adapter.

**Architecture:** Bulk copy 5 packages from `fh-agent/packages/` into `pi-stef/packages/`, then apply three systematic rename passes (scope, fh→sf, API namespace). Verification via grep + `pnpm typecheck` + `pnpm test`.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, pi extension API (`@earendil-works/pi-*`)

---

## Milestone M1: Copy Packages

Copy all 5 packages from fh-agent into pi-stef. Remove fh-agent-specific artifacts.

### Task M1-S1: Copy 4 dependency packages

**Files:**
- Create: `packages/agent-workflows/` (from `fh-agent/packages/agent-workflows/`)
- Create: `packages/atlassian/` (from `fh-agent/packages/atlassian/`)
- Create: `packages/figma/` (from `fh-agent/packages/figma/`)
- Create: `packages/web-access/` (from `fh-agent/packages/web-access/`)

- [ ] **Step 1: Copy packages excluding node_modules and lock files**

```bash
cd /Users/stefano/Projects/pi-stef
for pkg in agent-workflows atlassian figma web-access; do
  rsync -a --exclude='node_modules' --exclude='package-lock.json' \
    /Users/stefano/Projects/fh-agent/packages/$pkg/ packages/$pkg/
done
```

- [ ] **Step 2: Verify file structure**

```bash
find packages/agent-workflows packages/atlassian packages/figma packages/web-access -type f | wc -l
```

Expected: ~70+ source + test + config files total (no node_modules).

- [ ] **Step 3: Commit**

```bash
git add packages/agent-workflows/ packages/atlassian/ packages/figma/ packages/web-access/
git commit -m "chore: copy agent-workflows, atlassian, figma, web-access from fh-agent"
```

### Task M1-S2: Copy sf-team package

**Files:**
- Create: `packages/sf-team/` (from `fh-agent/packages/fh-team/`)

- [ ] **Step 1: Copy fh-team as sf-team**

```bash
rsync -a --exclude='node_modules' --exclude='package-lock.json' \
  /Users/stefano/Projects/fh-agent/packages/fh-team/ packages/sf-team/
```

- [ ] **Step 2: Verify file structure**

```bash
find packages/sf-team -type f | wc -l
```

Expected: ~200+ files (source, tests, config, templates, skills).

- [ ] **Step 3: Commit**

```bash
git add packages/sf-team/
git commit -m "chore: copy fh-team as sf-team from fh-agent (pre-rename)"
```

### Task M1-S3: Remove fh-agent-specific artifacts from sf-team

**Files:**
- Delete: `packages/sf-team/fh-agent.package.json`
- Delete: `packages/sf-team/package-lock.json` (if present)

- [ ] **Step 1: Remove fh-agent manifest and lock file**

```bash
rm -f packages/sf-team/fh-agent.package.json packages/sf-team/package-lock.json
```

- [ ] **Step 2: Commit**

```bash
git add -u packages/sf-team/
git commit -m "chore: remove fh-agent-specific artifacts from sf-team"
```

---

## Milestone M2: Scope Rename — `@life-of-pi` → `@pi-stef`

Rename the package scope in all 5 new packages. This covers package.json `name` fields, `file:` dependency links, and all import statements.

### Task M2-S1: Rename scope in package.json files

**Files:**
- Modify: `packages/agent-workflows/package.json`
- Modify: `packages/atlassian/package.json`
- Modify: `packages/figma/package.json`
- Modify: `packages/web-access/package.json`
- Modify: `packages/sf-team/package.json`

- [ ] **Step 1: Replace @life-of-pi with @pi-stef in all package.json files**

```bash
cd /Users/stefano/Projects/pi-stef
for pkg in agent-workflows atlassian figma web-access sf-team; do
  sed -i '' 's/@life-of-pi/@pi-stef/g' packages/$pkg/package.json
done
```

- [ ] **Step 2: Verify the changes**

```bash
grep -r "@life-of-pi" packages/*/package.json
```

Expected: no output (all replaced).

```bash
grep -r "@pi-stef" packages/*/package.json | head -20
```

Expected: scope references in `name`, `dependencies`, and `keywords` fields.

- [ ] **Step 3: Commit**

```bash
git add packages/*/package.json
git commit -m "refactor: rename @life-of-pi scope to @pi-stef in package.json files"
```

### Task M2-S2: Rename scope in TypeScript imports across all 5 packages

**Files:**
- Modify: all `.ts` files in `packages/{agent-workflows,atlassian,figma,web-access,sf-team}/`

- [ ] **Step 1: Replace @life-of-pi with @pi-stef in all .ts files**

```bash
cd /Users/stefano/Projects/pi-stef
for pkg in agent-workflows atlassian figma web-access sf-team; do
  find packages/$pkg -name '*.ts' -exec sed -i '' 's/@life-of-pi/@pi-stef/g' {} +
done
```

- [ ] **Step 2: Verify the changes**

```bash
grep -r "@life-of-pi" packages/ --include="*.ts" | wc -l
```

Expected: 0.

- [ ] **Step 3: Commit**

```bash
git add packages/
git commit -m "refactor: rename @life-of-pi imports to @pi-stef in TypeScript files"
```

### Task M2-S3: Rename scope in docs, config, YAML, and shell scripts

**Files:**
- Modify: all `.md`, `.json`, `.yaml`, `.yml`, `.sh`, `.mjs` files in the 5 new packages

- [ ] **Step 1: Replace @life-of-pi with @pi-stef in non-TS files**

```bash
cd /Users/stefano/Projects/pi-stef
for pkg in agent-workflows atlassian figma web-access sf-team; do
  find packages/$pkg -type f \( -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' -o -name '*.mjs' \) \
    -exec sed -i '' 's/@life-of-pi/@pi-stef/g' {} +
done
```

- [ ] **Step 2: Verify**

```bash
grep -r "@life-of-pi" packages/ | wc -l
```

Expected: 0.

- [ ] **Step 3: Commit**

```bash
git add packages/
git commit -m "refactor: rename @life-of-pi to @pi-stef in docs, config, and scripts"
```

---

## Milestone M3: fh→sf Rename in sf-team

Rename all fh/fh-team/First Horizon references in the sf-team package to sf-team equivalents.

### Task M3-S1: Rename file extensions/fh-team.ts → sf-team.ts

**Files:**
- Rename: `packages/sf-team/extensions/fh-team.ts` → `packages/sf-team/extensions/sf-team.ts`

- [ ] **Step 1: Rename the extension entry file**

```bash
mv packages/sf-team/extensions/fh-team.ts packages/sf-team/extensions/sf-team.ts
```

- [ ] **Step 2: Commit**

```bash
git add -A packages/sf-team/extensions/
git commit -m "refactor: rename extensions/fh-team.ts to sf-team.ts"
```

### Task M3-S2: Rename fh→sf in sf-team TypeScript source files

**Files:**
- Modify: all `.ts` files in `packages/sf-team/src/`, `packages/sf-team/extensions/`, `packages/sf-team/tests/`

- [ ] **Step 1: Replace PascalCase FhTeam → SfTeam**

```bash
cd /Users/stefano/Projects/pi-stef
find packages/sf-team -name '*.ts' -exec sed -i '' 's/FhTeam/SfTeam/g' {} +
```

- [ ] **Step 2: Replace camelCase fhTeam → sfTeam**

```bash
find packages/sf-team -name '*.ts' -exec sed -i '' 's/fhTeam/sfTeam/g' {} +
```

- [ ] **Step 3: Replace snake_case fh_team → sf_team**

```bash
find packages/sf-team -name '*.ts' -exec sed -i '' 's/fh_team/sf_team/g' {} +
```

- [ ] **Step 4: Replace kebab-case fh-team → sf-team**

```bash
find packages/sf-team -name '*.ts' -exec sed -i '' 's/fh-team/sf-team/g' {} +
```

- [ ] **Step 5: Replace bare "fh " (word boundary) — careful to avoid false matches in words like "branch", "fingerprint"**

```bash
# Only match 'fh' as a standalone identifier (after dot, in strings, as variable prefix)
# Skip this if it causes false positives — verify after running
find packages/sf-team -name '*.ts' -exec sed -i '' 's/fh-team/sf-team/g; s/fh_team/sf_team/g' {} +
# Re-run to catch any remaining 'fh' as part of compound identifiers:
# grep for remaining occurrences first
grep -rn '"fh' packages/sf-team/src/ --include="*.ts" | head -20
```

- [ ] **Step 6: Verify — check for remaining fh references in TS files**

```bash
grep -rn 'fh[_-]' packages/sf-team/src/ packages/sf-team/extensions/ --include="*.ts"
```

Expected: 0 matches (all fh_team and fh-team replaced).

```bash
grep -rn 'fhTeam\|FhTeam' packages/sf-team/src/ packages/sf-team/extensions/ --include="*.ts"
```

Expected: 0 matches.

- [ ] **Step 7: Commit**

```bash
git add packages/sf-team/
git commit -m "refactor: rename fh→sf in sf-team TypeScript source"
```

### Task M3-S3: Rename fh→sf in sf-team test files

**Files:**
- Modify: all `.ts` files in `packages/sf-team/tests/`

- [ ] **Step 1: Apply same replacements in test files**

```bash
cd /Users/stefano/Projects/pi-stef
find packages/sf-team/tests -name '*.ts' -exec sed -i '' \
  -e 's/FhTeam/SfTeam/g' \
  -e 's/fhTeam/sfTeam/g' \
  -e 's/fh_team/sf_team/g' \
  -e 's/fh-team/sf-team/g' \
  {} +
```

- [ ] **Step 2: Verify**

```bash
grep -rn 'fh[_-]\|fhTeam\|FhTeam' packages/sf-team/tests/ --include="*.ts" | head -20
```

Expected: 0 matches.

- [ ] **Step 3: Commit**

```bash
git add packages/sf-team/tests/
git commit -m "refactor: rename fh→sf in sf-team test files"
```

### Task M3-S4: Rename fh→sf in sf-team docs, config, YAML, scripts, and templates

**Files:**
- Modify: `packages/sf-team/README.md`
- Modify: `packages/sf-team/config/defaults.json`
- Modify: `packages/sf-team/skills/team/planner.yaml`
- Modify: `packages/sf-team/scripts/pretty-pane.mjs`
- Modify: all `.md` files in `packages/sf-team/templates/`

- [ ] **Step 1: Apply replacements in non-TS files**

```bash
cd /Users/stefano/Projects/pi-stef
find packages/sf-team -type f \( -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' -o -name '*.mjs' \) \
  -exec sed -i '' \
    -e 's/FH_TEAM/SF_TEAM/g' \
    -e 's/fh-team/sf-team/g' \
    -e 's/fh_team/sf_team/g' \
    -e 's/\.fh-team/.sf-team/g' \
    {} +
```

- [ ] **Step 2: Handle "First Horizon" and "first horizon" references**

```bash
grep -rn -i 'first horizon\|firsthorizon\|FirstHorizon' packages/sf-team/ | head -20
```

If matches found, replace with context-appropriate text or remove. The `agent-workflows` package description says "First Horizon agent extensions" — change to "agent extensions".

```bash
find packages/sf-team -type f \( -name '*.md' -o -name '*.json' \) \
  -exec sed -i '' 's/First Horizon //g; s/First Horizon//g; s/first horizon//g' {} +
```

- [ ] **Step 3: Verify**

```bash
grep -rn -i 'fh[_-]\|fhTeam\|FhTeam\|FH_TEAM\|first.horizon\|firsthorizon' packages/sf-team/ --include="*.md" --include="*.json" --include="*.yaml" --include="*.mjs"
```

Expected: 0 matches.

- [ ] **Step 4: Commit**

```bash
git add packages/sf-team/
git commit -m "refactor: rename fh→sf in sf-team docs, config, and scripts"
```

### Task M3-S5: Rename test files containing fh in their filename

**Files:**
- Rename any test files with "fh" in their name

- [ ] **Step 1: Find test files with fh in filename**

```bash
find packages/sf-team/tests -name '*fh*' -o -name '*fh-*'
```

If none found (tests use descriptive names like `register-steer.test.ts`), skip to Step 3.

- [ ] **Step 2: Rename any matching files**

```bash
# Example (adjust based on actual findings):
for f in packages/sf-team/tests/*fh*; do
  mv "$f" "$(echo "$f" | sed 's/fh/sf/g')"
done
```

Also rename `tests/e2e/fh-team-auto-smoke.test.ts` if it exists:

```bash
if [ -f packages/sf-team/tests/e2e/fh-team-auto-smoke.test.ts ]; then
  mv packages/sf-team/tests/e2e/fh-team-auto-smoke.test.ts \
     packages/sf-team/tests/e2e/sf-team-auto-smoke.test.ts
fi
```

- [ ] **Step 3: Commit**

```bash
git add -A packages/sf-team/tests/
git commit -m "refactor: rename fh→sf in sf-team test filenames"
```

---

## Milestone M4: Fix API Namespace in superpowers-adapter

Replace `@mariozechner/pi-*` with `@earendil-works/pi-*` in the existing superpowers-adapter package.

### Task M4-S1: Replace @mariozechner with @earendil-works in superpowers-adapter

**Files:**
- Modify: `packages/superpowers-adapter/package.json`
- Modify: `packages/superpowers-adapter/src/index.ts`
- Modify: `packages/superpowers-adapter/src/commands.ts`
- Modify: `packages/superpowers-adapter/src/tools/todo-write.ts`
- Modify: `packages/superpowers-adapter/src/tools/task.ts`
- Modify: `packages/superpowers-adapter/src/tools/skill.ts`

- [ ] **Step 1: Replace in all superpowers-adapter files**

```bash
cd /Users/stefano/Projects/pi-stef
find packages/superpowers-adapter -type f \( -name '*.ts' -o -name '*.json' \) \
  -exec sed -i '' 's/@mariozechner\/pi-/@earendil-works\/pi-/g' {} +
```

- [ ] **Step 2: Verify**

```bash
grep -rn "@mariozechner" packages/superpowers-adapter/
```

Expected: 0 matches.

```bash
grep -rn "@earendil-works/pi-" packages/superpowers-adapter/
```

Expected: 10 matches (3 in package.json peerDeps, 7 in TS imports).

- [ ] **Step 3: Commit**

```bash
git add packages/superpowers-adapter/
git commit -m "fix: correct pi API namespace @mariozechner → @earendil-works in superpowers-adapter"
```

---

## Milestone M5: Update Root Configuration

Wire the new packages into pi-stef's monorepo infrastructure.

### Task M5-S1: Update root tsconfig.json with new package references

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Add references for all 5 new packages**

Current `tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "packages/superpowers-adapter" }
  ]
}
```

Replace with:
```json
{
  "files": [],
  "references": [
    { "path": "packages/superpowers-adapter" },
    { "path": "packages/agent-workflows" },
    { "path": "packages/atlassian" },
    { "path": "packages/figma" },
    { "path": "packages/sf-team" },
    { "path": "packages/web-access" }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add new package references to root tsconfig.json"
```

### Task M5-S2: Ensure each new package has a valid tsconfig.json

**Files:**
- Modify or create: `packages/agent-workflows/tsconfig.json`
- Modify or create: `packages/atlassian/tsconfig.json`
- Modify or create: `packages/figma/tsconfig.json`
- Modify or create: `packages/sf-team/tsconfig.json`
- Modify or create: `packages/web-access/tsconfig.json`

- [ ] **Step 1: Check existing tsconfig files**

The sf-team tsconfig extends `../../tsconfig.json` (from fh-agent). It must be updated to extend `../../tsconfig.base.json` and include `"composite": true`, matching superpowers-adapter's pattern.

```bash
cat packages/sf-team/tsconfig.json
```

Current (from fh-agent):
```json
{
  "extends": "../../tsconfig.json",
  "include": [
    "extensions/**/*.ts",
    "src/**/*.ts",
    "tests/**/*.ts",
    "bin/**/*.ts"
  ]
}
```

Replace with:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true
  },
  "include": [
    "extensions/**/*.ts",
    "src/**/*.ts",
    "tests/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 2: Check and fix the other 4 packages' tsconfig files**

For each of agent-workflows, atlassian, figma, web-access — check if their tsconfig extends `../../tsconfig.json` and fix to `../../tsconfig.base.json`. Add `"composite": true` if missing.

```bash
for pkg in agent-workflows atlassian figma web-access; do
  if [ -f packages/$pkg/tsconfig.json ]; then
    sed -i '' 's|"extends": "../../tsconfig.json"|"extends": "../../tsconfig.base.json"|g' packages/$pkg/tsconfig.json
    echo "=== $pkg ==="
    cat packages/$pkg/tsconfig.json
  fi
done
```

If any package is missing `"composite": true` in compilerOptions, add it.

- [ ] **Step 3: Commit**

```bash
git add packages/*/tsconfig.json
git commit -m "chore: fix tsconfig extends and composite settings for new packages"
```

### Task M5-S3: Update install script

**Files:**
- Modify: `scripts/install-all.sh`

- [ ] **Step 1: Add new packages to PACKAGES array**

Current:
```bash
PACKAGES=("superpowers-adapter")
```

Replace with:
```bash
PACKAGES=("superpowers-adapter" "agent-workflows" "atlassian" "figma" "sf-team" "web-access")
```

- [ ] **Step 2: Commit**

```bash
git add scripts/install-all.sh
git commit -m "chore: add new packages to install-all.sh"
```

### Task M5-S4: Update root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add new packages to the packages table**

Current table:
```markdown
| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter` |
```

Replace with:
```markdown
| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter` |
| [sf-team](packages/sf-team/README.md) | extension | Steerable team of role-agents for plan/review/implement workflows | `pi install git:github.com/<USER>/pi-stef#packages/sf-team` |
| [agent-workflows](packages/agent-workflows/README.md) | library | Reusable workflow engine primitives | `pi install git:github.com/<USER>/pi-stef#packages/agent-workflows` |
| [atlassian](packages/atlassian/README.md) | extension | Jira and Confluence integration tools | `pi install git:github.com/<USER>/pi-stef#packages/atlassian` |
| [figma](packages/figma/README.md) | extension | Figma REST API tools and design context | `pi install git:github.com/<USER>/pi-stef#packages/figma` |
| [web-access](packages/web-access/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install git:github.com/<USER>/pi-stef#packages/web-access` |
```

Also update the pi-depo kit.yml example to show sf-team:
```yaml
packages:
  superpowers-adapter:
    source: "git:github.com/<USER>/pi-stef#packages/superpowers-adapter"
    rating: core
  sf-team:
    source: "git:github.com/<USER>/pi-stef#packages/sf-team"
    rating: core
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add new packages to root README"
```

---

## Milestone M6: "First Horizon" / fh Cleanup Pass

Catch any remaining references across all 5 new packages (not just sf-team).

### Task M6-S1: Sweep for remaining @life-of-pi references

- [ ] **Step 1: Search all new packages**

```bash
grep -rn "@life-of-pi" packages/agent-workflows/ packages/atlassian/ packages/figma/ packages/web-access/ packages/sf-team/ --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml" --include="*.mjs" --include="*.sh"
```

Expected: 0 matches. If found, fix with:

```bash
find packages/ -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.mjs' -o -name '*.sh' \) \
  -exec sed -i '' 's/@life-of-pi/@pi-stef/g' {} +
```

- [ ] **Step 2: Commit if changes were made**

```bash
git add packages/
git commit -m "refactor: final @life-of-pi → @pi-stef cleanup"
```

### Task M6-S2: Sweep for remaining "First Horizon" references

- [ ] **Step 1: Search all new packages**

```bash
grep -rn -i "first horizon\|firsthorizon\|FirstHorizon" packages/ --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml"
```

Expected: 0 matches. If found, replace with context-appropriate text or remove.

- [ ] **Step 2: Commit if changes were made**

```bash
git add packages/
git commit -m "refactor: remove remaining First Horizon references"
```

### Task M6-S3: Sweep for remaining @mariozechner references

- [ ] **Step 1: Search entire pi-stef project**

```bash
grep -rn "@mariozechner" --include="*.ts" --include="*.json" --exclude-dir=node_modules .
```

Expected: 0 matches. If found, replace with `@earendil-works`.

- [ ] **Step 2: Commit if changes were made**

```bash
git add .
git commit -m "refactor: final @mariozechner → @earendil-works cleanup"
```

---

## Milestone M7: Verification

Run type checking, tests, and a final grep sweep.

### Task M7-S1: Install dependencies and run typecheck

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/stefano/Projects/pi-stef
pnpm install
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes. If errors are found, fix import paths or missing `composite: true` in tsconfig files.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve typecheck errors after package extraction"
```

### Task M7-S2: Run tests

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Note: sf-team has ~130+ test files. Some may fail due to:
- Import path mismatches
- Mock references to `fh-team` that were renamed
- Config path changes (`~/.pi/fh-team/` → `~/.pi/sf-team/`)

Expected: tests for superpowers-adapter pass (API namespace fix only). sf-team tests may need targeted fixes.

- [ ] **Step 2: Fix any test failures**

Investigate each failure. Common fixes:
- Update mock module paths
- Update string assertions referencing `fh-team` → `sf-team`
- Update config path assertions

- [ ] **Step 3: Re-run tests until passing**

```bash
pnpm test
```

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures after package extraction"
```

### Task M7-S3: Final grep verification

- [ ] **Step 1: Verify zero remaining fh references in sf-team**

```bash
grep -rn -i 'fh-team\|fh_team\|fhTeam\|FhTeam\|FH_TEAM' packages/sf-team/ --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml" --include="*.mjs"
```

Expected: 0 matches.

- [ ] **Step 2: Verify zero remaining @life-of-pi references**

```bash
grep -rn "@life-of-pi" packages/ --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml"
```

Expected: 0 matches.

- [ ] **Step 3: Verify zero remaining @mariozechner references**

```bash
grep -rn "@mariozechner" --include="*.ts" --include="*.json" --exclude-dir=node_modules .
```

Expected: 0 matches.

- [ ] **Step 4: Verify README lists all 6 packages**

```bash
grep "^|" README.md | grep -v "^| Package\|^|---"
```

Expected: 6 package rows.

---

## Execution Rules

- Run lint/typecheck/tests after each milestone.
- Prefer linting changed files only for speed.
- Commit locally after each completed milestone (**do not push**).
- Stop and ask user for feedback.
- Apply feedback, rerun checks, and commit again.
- Move to next milestone only after user approval.
- After all milestones are completed and approved, ask permission to push.
- Only after approved push: mark plan as completed.
