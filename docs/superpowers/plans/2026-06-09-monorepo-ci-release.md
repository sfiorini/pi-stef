# Monorepo CI & Release System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive version bump script and GitHub CI publish workflow for the pi-stef monorepo, enabling per-package npm publishing.

**Architecture:** A local Node.js script (`scripts/release.mjs`) handles interactive package selection, version bumping, changelog updates, test gating, git commit, tagging, and pushing. A thin GitHub Actions workflow triggers on tag push to build and publish the tagged package to npm.

**Tech Stack:** Node.js (ESM, built-ins only), pnpm workspaces, GitHub Actions, npm

---

## File Structure

| File | Purpose |
|---|---|
| `scripts/release.mjs` | Interactive version bump and release script |
| `.github/workflows/publish.yml` | CI workflow triggered by tag push |
| `packages/<name>/CHANGELOG.md` | Per-package changelog (8 files) |
| `package.json` (root) | Add `release` script alias |

---

## Milestone 1: Changelog Infrastructure

### Task 1: Create CHANGELOG.md for all 8 packages

**Files:**
- Create: `packages/agent-workflows/CHANGELOG.md`
- Create: `packages/atlassian/CHANGELOG.md`
- Create: `packages/catalog/CHANGELOG.md`
- Create: `packages/figma/CHANGELOG.md`
- Create: `packages/paths/CHANGELOG.md`
- Create: `packages/superpowers-adapter/CHANGELOG.md`
- Create: `packages/team/CHANGELOG.md`
- Create: `packages/web/CHANGELOG.md`

- [ ] **Step 1: Create CHANGELOG.md for each package**

All 8 packages get the same initial changelog template. The content is identical — a header and an unreleased section. The `## [0.2.0]` section documents the current version as the baseline.

```bash
for pkg in agent-workflows atlassian catalog figma paths superpowers-adapter team web; do
  cat > "packages/${pkg}/CHANGELOG.md" << 'CHANGELOG'
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-06-09
### Added
- Initial monorepo setup
CHANGELOG
done
```

- [ ] **Step 2: Verify all changelogs were created**

Run: `ls -la packages/*/CHANGELOG.md`

Expected: 8 files, one per package.

- [ ] **Step 3: Commit**

```bash
git add packages/*/CHANGELOG.md
git commit -m "docs(changelog): add CHANGELOG.md to all packages"
```

---

## Milestone 2: Release Script

### Task 2: Package discovery and version reading

**Files:**
- Create: `scripts/release.mjs`

- [ ] **Step 1: Create the script skeleton with package discovery**

This script discovers all packages under `packages/`, reads their `name` and `version` from `package.json`, and prints them. It uses only Node.js built-ins (`fs`, `path`).

```javascript
#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

/**
 * Discover all packages in the monorepo.
 * Returns array of { dirName, name, version, pkgPath }.
 */
function discoverPackages() {
  const entries = readdirSync(PACKAGES_DIR, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, entry.name, "package.json");
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.name) {
        packages.push({
          dirName: entry.name,
          name: pkg.name,
          version: pkg.version || "0.0.0",
          pkgPath,
        });
      }
    } catch {
      // skip directories without a valid package.json
    }
  }

  return packages.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// --- Main ---
const pkgs = discoverPackages();
console.log("Discovered packages:");
for (const pkg of pkgs) {
  console.log(`  ${pkg.name} (${pkg.version})`);
}
```

- [ ] **Step 2: Test package discovery**

Run: `node scripts/release.mjs`

Expected output (order may vary):
```
Discovered packages:
  @pi-stef/agent-workflows (0.2.0)
  @pi-stef/atlassian (0.2.0)
  @pi-stef/catalog (0.2.0)
  @pi-stef/figma (0.2.0)
  @pi-stef/paths (0.2.0)
  @pi-stef/superpowers-adapter (0.2.0)
  @pi-stef/team (0.2.0)
  @pi-stef/web (0.2.0)
```

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add script skeleton with package discovery"
```

---

### Task 3: Interactive menu — package selection

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add readline-based interactive menu**

Replace the `// --- Main ---` section at the bottom of `scripts/release.mjs` with the following. Add the `readline` import at the top alongside the existing imports.

Add to imports at top of file:

```javascript
import { createInterface } from "node:readline";
```

Add helper function after `discoverPackages`:

```javascript
/**
 * Prompt the user with a question and return their answer.
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Show the package selection menu and return the chosen package(s).
 * Returns null if the user quits.
 */
async function selectPackage(rl, packages) {
  console.log("\n? Select a package to release:\n");
  for (let i = 0; i < packages.length; i++) {
    console.log(`  ${i + 1}) ${packages[i].dirName} (${packages[i].version})`);
  }
  console.log(`  all) Release all packages`);
  console.log(`  q) Quit\n`);

  const answer = await ask(rl, "Choice: ");

  if (answer === "q" || answer === "Q") {
    return null;
  }

  if (answer === "all") {
    return packages;
  }

  const index = parseInt(answer, 10);
  if (isNaN(index) || index < 1 || index > packages.length) {
    console.error(`Invalid choice: "${answer}"`);
    process.exit(1);
  }

  return [packages[index - 1]];
}
```

Replace the `// --- Main ---` section with:

```javascript
// --- Main ---
async function main() {
  const pkgs = discoverPackages();
  if (pkgs.length === 0) {
    console.error("No packages found.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selected = await selectPackage(rl, pkgs);

  if (!selected) {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  console.log(`\nSelected: ${selected.map((p) => p.dirName).join(", ")}`);
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Test the interactive menu**

Run: `echo "1" | node scripts/release.mjs`

Expected: Shows the menu, selects the first package, prints `Selected: agent-workflows`.

Run: `echo "all" | node scripts/release.mjs`

Expected: Shows the menu, selects all, prints `Selected: agent-workflows, atlassian, catalog, ...`.

Run: `echo "q" | node scripts/release.mjs`

Expected: Prints `Aborted.` and exits.

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add interactive package selection menu"
```

---

### Task 4: Bump type selection and version calculation

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add bump type selection and semver calculation**

Add these functions after `selectPackage`:

```javascript
/**
 * Prompt for bump type (major/minor/patch).
 */
async function selectBumpType(rl, label) {
  console.log(`\n? Bump type for ${label}:`);
  console.log("  1) patch");
  console.log("  2) minor");
  console.log("  3) major\n");

  const answer = await ask(rl, "Choice: ");

  switch (answer) {
    case "1":
      return "patch";
    case "2":
      return "minor";
    case "3":
      return "major";
    default:
      if (["patch", "minor", "major"].includes(answer)) return answer;
      console.error(`Invalid bump type: "${answer}"`);
      process.exit(1);
  }
}

/**
 * Calculate the new version given a current version and bump type.
 * Returns the new version string.
 */
function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid version format: "${version}"`);
  }

  let [, major, minor, patch] = match.map(Number);

  switch (type) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
  }

  return `${major}.${minor}.${patch}`;
}
```

- [ ] **Step 2: Test version calculation**

Add a temporary test at the bottom of the file (before `main()`), run it, then remove it:

```javascript
// Quick sanity check
console.assert(bumpVersion("0.2.0", "patch") === "0.2.1", "patch failed");
console.assert(bumpVersion("0.2.0", "minor") === "0.3.0", "minor failed");
console.assert(bumpVersion("0.2.0", "major") === "1.0.0", "major failed");
console.log("Version calculation tests passed.");
```

Run: `node scripts/release.mjs`

Expected: `Version calculation tests passed.` before the menu appears. Remove the test lines after verifying.

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add bump type selection and version calculation"
```

---

### Task 5: Version update and private flag removal

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add package.json update function**

Add this function after `bumpVersion`:

```javascript
/**
 * Update a package's version in package.json and remove the private flag.
 * Returns the new version string.
 */
function updatePackageVersion(pkgPath, newVersion) {
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);

  pkg.version = newVersion;

  // Remove private flag to allow npm publishing
  if (pkg.private) {
    delete pkg.private;
  }

  // Write back with the same formatting (2-space indent, trailing newline)
  const updated = JSON.stringify(pkg, null, 2) + "\n";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pkgPath, updated, "utf-8");

  return newVersion;
}
```

Wait — `await import` inside a sync function won't work. Since we already import `readFileSync` at the top, we need `writeFileSync` too. Fix the import:

Change the import at the top of the file from:

```javascript
import { readdirSync, readFileSync } from "node:fs";
```

to:

```javascript
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
```

Then fix `updatePackageVersion` to use it directly:

```javascript
/**
 * Update a package's version in package.json and remove the private flag.
 */
function updatePackageVersion(pkgPath, newVersion) {
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);

  pkg.version = newVersion;

  // Remove private flag to allow npm publishing
  if (pkg.private) {
    delete pkg.private;
  }

  // Write back with 2-space indent and trailing newline
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 2: Wire bump into the main flow**

In the `main()` function, after the `selectPackage` block and before `rl.close()`, add:

```javascript
  // Select bump type
  const isAll = selected.length > 1;
  const bumpLabel = isAll ? "all packages" : selected[0].dirName;
  const bumpType = await selectBumpType(rl, bumpLabel);

  // Calculate new versions
  const releases = selected.map((pkg) => ({
    ...pkg,
    newVersion: bumpVersion(pkg.version, bumpType),
  }));

  // Show preview
  console.log("\nPlanned releases:");
  for (const r of releases) {
    console.log(`  ${r.dirName}: ${r.version} → ${r.newVersion}`);
  }
  const confirm = await ask(rl, "\nProceed? (y/n): ");
  if (confirm !== "y") {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  // Update package.json files
  for (const r of releases) {
    updatePackageVersion(r.pkgPath, r.newVersion);
    console.log(`  Updated ${r.dirName}/package.json`);
  }
```

- [ ] **Step 3: Test version update (dry run)**

Run: `echo -e "1\npatch\ny" | node scripts/release.mjs`

Expected:
- Selects agent-workflows
- Shows `agent-workflows: 0.2.0 → 0.2.1`
- Prompts `Proceed? (y/n):`
- Prints `Updated agent-workflows/package.json`

Then verify the file was actually changed:

Run: `git diff packages/agent-workflows/package.json`

Expected: `version` changed from `0.2.0` to `0.2.1`, `private` field removed.

**Revert the test change:**

Run: `git checkout -- packages/agent-workflows/package.json`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add version update with private flag removal"
```

---

### Task 6: Changelog update logic

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add changelog update function**

Add this function after `updatePackageVersion`:

```javascript
/**
 * Update a package's CHANGELOG.md with a new version entry.
 * If the file doesn't exist, creates it.
 * If [Unreleased] section exists, replaces it with the new version + fresh [Unreleased].
 * If [Unreleased] is missing, inserts the new version after the header.
 */
function updateChangelog(pkgDir, newVersion) {
  const { existsSync } = require("node:fs");
  const changelogPath = join(PACKAGES_DIR, pkgDir, "CHANGELOG.md");
  const today = new Date().toISOString().split("T")[0];

  const newEntry = `## [Unreleased]

## [${newVersion}] - ${today}
### Changed
- Version bump
`;

  if (!existsSync(changelogPath)) {
    // Create new changelog
    const content = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

${newEntry}`;
    writeFileSync(changelogPath, content, "utf-8");
    return;
  }

  let content = readFileSync(changelogPath, "utf-8");

  if (content.includes("## [Unreleased]")) {
    // Replace [Unreleased] with new version entry
    content = content.replace("## [Unreleased]", newEntry);
  } else {
    // Insert after the first "# Changelog" header line
    const headerEnd = content.indexOf("\n", content.indexOf("# Changelog"));
    if (headerEnd !== -1) {
      content =
        content.slice(0, headerEnd + 1) +
        "\n" +
        newEntry +
        "\n" +
        content.slice(headerEnd + 1);
    } else {
      // Fallback: prepend
      content = newEntry + "\n" + content;
    }
  }

  writeFileSync(changelogPath, content, "utf-8");
}
```

Wait — I used `require("node:fs")` but this is an ESM file. Fix: use the already-imported `existsSync` from the top import. Update the import:

Change:

```javascript
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
```

to:

```javascript
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
```

Then remove the `const { existsSync } = require("node:fs");` line from `updateChangelog`.

- [ ] **Step 2: Wire changelog update into the main flow**

In `main()`, after the `updatePackageVersion` loop and before `rl.close()`, add:

```javascript
  // Update changelogs
  for (const r of releases) {
    updateChangelog(r.dirName, r.newVersion);
    console.log(`  Updated ${r.dirName}/CHANGELOG.md`);
  }
```

- [ ] **Step 3: Test changelog update (dry run)**

Run: `echo -e "1\npatch\ny" | node scripts/release.mjs`

Then check the changelog:

Run: `head -15 packages/agent-workflows/CHANGELOG.md`

Expected:
```
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-06-09
### Changed
- Version bump

## [0.2.0] - 2026-06-09
```

**Revert the test change:**

Run: `git checkout -- packages/agent-workflows/package.json packages/agent-workflows/CHANGELOG.md`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add changelog update logic"
```

---

### Task 7: Pre-flight checks — dirty working directory and test gate

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add git dirty check and test runner**

Add `execSync` to the import from `node:child_process`:

Add a new import after the `fs` import:

```javascript
import { execSync } from "node:child_process";
```

Add these functions after `updateChangelog`:

```javascript
/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: opts.silent ? "pipe" : "inherit",
    ...opts,
  }).trim();
}

/**
 * Check that the git working directory is clean.
 * Aborts if there are uncommitted changes.
 */
function assertCleanWorkingDir() {
  const status = run("git status --porcelain", { silent: true });
  if (status.length > 0) {
    console.error(
      "\n❌ Working directory is not clean. Commit or stash changes first."
    );
    console.error(status);
    process.exit(1);
  }
}

/**
 * Run the test suite. Aborts if tests fail.
 */
function runTests() {
  console.log("\n⏳ Running tests...");
  try {
    run("pnpm test");
    console.log("✅ Tests passed.");
  } catch {
    console.error("\n❌ Tests must pass before releasing.");
    process.exit(1);
  }
}

/**
 * Check that a tag doesn't already exist.
 */
function assertTagDoesNotExist(tag) {
  try {
    run(`git rev-parse "${tag}"`, { silent: true });
    console.error(`\n❌ Tag "${tag}" already exists.`);
    process.exit(1);
  } catch {
    // Tag doesn't exist — good
  }
}
```

- [ ] **Step 2: Wire pre-flight checks into the main flow**

In `main()`, add these checks **before** the bump type selection (after `selectPackage`):

```javascript
  // Pre-flight checks
  assertCleanWorkingDir();
  runTests();
```

Also, after showing the preview and before `Proceed? (y/n)`, add tag existence checks:

```javascript
  // Check tags don't exist
  for (const r of releases) {
    const tag = `${r.name}@${r.newVersion}`;
    assertTagDoesNotExist(tag);
  }
```

- [ ] **Step 3: Test dirty working directory check**

Create a temporary file to dirty the working directory:

Run: `touch /tmp/test-dirty && cp /tmp/test-dirty /Users/stefano/Projects/pi-stef/dirty-test-file`

Run: `echo "1" | node scripts/release.mjs`

Expected: `❌ Working directory is not clean. Commit or stash changes first.` followed by the dirty file listing.

Clean up: `rm /Users/stefano/Projects/pi-stef/dirty-test-file`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add pre-flight checks for dirty dir and tests"
```

---

### Task 8: Git operations — commit, tag, push

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add git commit, tag, and push functions**

Add these functions after `assertTagDoesNotExist`:

```javascript
/**
 * Stage files, commit, create tags, and push.
 */
function gitRelease(releases, isAll) {
  // Stage all changed package.json and CHANGELOG.md files
  const files = releases
    .map(
      (r) =>
        `packages/${r.dirName}/package.json packages/${r.dirName}/CHANGELOG.md`
    )
    .join(" ");

  run(`git add ${files}`);

  // Commit
  const version = releases[0].newVersion;
  const commitMsg = isAll
    ? `release(all): v${version}`
    : `release(${releases[0].dirName}): v${version}`;

  run(`git commit -m "${commitMsg}"`);
  console.log(`\n✅ Committed: ${commitMsg}`);

  // Create tags
  for (const r of releases) {
    const tag = `${r.name}@${r.newVersion}`;
    run(`git tag "${tag}"`);
    console.log(`  Tagged: ${tag}`);
  }

  // Push
  console.log("\n⏳ Pushing to origin...");
  run("git push origin main");
  run("git push origin --tags");
  console.log("✅ Pushed commits and tags.");
}
```

- [ ] **Step 2: Wire git operations into the main flow**

In `main()`, after the changelog update loop and before `rl.close()`, add:

```javascript
  // Git commit, tag, push
  gitRelease(releases, isAll);

  console.log("\n🎉 Release complete!");
  console.log("CI will now publish to npm when tags are processed.");
```

- [ ] **Step 3: Verify the complete script reads correctly**

Run: `node --check scripts/release.mjs`

Expected: No output (syntax check passes).

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add git commit, tag, and push operations"
```

---

## Milestone 3: CI Workflow

### Task 9: Create GitHub Actions publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] **Step 1: Create the workflow directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write the publish workflow**

```yaml
name: Publish to npm

on:
  push:
    tags:
      - "@pi-stef/*@*"

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Parse tag
        id: tag
        run: |
          TAG="${GITHUB_REF_NAME}"
          # Extract package name: everything before the last @version
          # Format: @pi-stef/<pkg>@<version>
          PKG_NAME="${TAG%@*}"        # @pi-stef/catalog
          VERSION="${TAG##*@}"         # 1.3.0
          PKG_DIR="${PKG_NAME#@pi-stef/}"  # catalog

          echo "pkg_name=${PKG_NAME}" >> "$GITHUB_OUTPUT"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
          echo "pkg_dir=${PKG_DIR}" >> "$GITHUB_OUTPUT"

          echo "Package: ${PKG_NAME}"
          echo "Version: ${VERSION}"
          echo "Directory: ${PKG_DIR}"

      - name: Verify version matches package.json
        run: |
          PKG_VERSION=$(node -p "require('./packages/${{ steps.tag.outputs.pkg_dir }}/package.json').version")
          if [ "${PKG_VERSION}" != "${{ steps.tag.outputs.version }}" ]; then
            echo "❌ Version mismatch!"
            echo "  Tag version: ${{ steps.tag.outputs.version }}"
            echo "  package.json version: ${PKG_VERSION}"
            exit 1
          fi
          echo "✅ Version verified: ${PKG_VERSION}"

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm test

      - name: Publish to npm
        run: pnpm --filter ${{ steps.tag.outputs.pkg_name }} publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        run: |
          PKG_DIR="${{ steps.tag.outputs.pkg_dir }}"
          VERSION="${{ steps.tag.outputs.version }}"
          TAG="${{ github.ref_name }}"

          # Extract changelog section for this version
          CHANGELOG_FILE="packages/${PKG_DIR}/CHANGELOG.md"
          if [ -f "$CHANGELOG_FILE" ]; then
            # Extract text between ## [VERSION] and the next ## heading
            BODY=$(sed -n "/^## \[${VERSION}\]/,/^## \[/p" "$CHANGELOG_FILE" | sed '$d')
          else
            BODY="Release ${VERSION}"
          fi

          gh release create "$TAG" \
            --title "${PKG_DIR} v${VERSION}" \
            --notes "$BODY"
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 3: Validate YAML syntax**

Run: `node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('.github/workflows/publish.yml', 'utf-8')); console.log('YAML is valid')"`

Expected: `YAML is valid` (if `yaml` package is available, otherwise skip — the CI will validate on push).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add publish workflow for npm releases"
```

---

## Milestone 4: Root Configuration

### Task 10: Add release script alias to root package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the release script**

In the root `package.json`, add `"release"` to the `scripts` section:

```json
{
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "release": "node scripts/release.mjs"
  }
}
```

- [ ] **Step 2: Verify the script works**

Run: `echo "q" | pnpm release`

Expected: Shows the package menu, prints `Aborted.` on `q`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add release script alias to root package.json"
```

---

## Final Verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 3: Verify the complete flow (dry run without push)**

To test the full flow without actually pushing, you can temporarily modify the script to skip the push step, or test on a branch:

```bash
git checkout -b test-release-flow
echo -e "1\npatch\ny" | node scripts/release.mjs
```

This will attempt the full flow. On a branch, the push will go to the branch instead of main. Verify:
- package.json was updated
- CHANGELOG.md was updated
- Commit was created
- Tag was created

Then clean up:

```bash
git checkout main
git branch -D test-release-flow
git tag -d "@pi-stef/agent-workflows@0.2.1" 2>/dev/null || true
```
