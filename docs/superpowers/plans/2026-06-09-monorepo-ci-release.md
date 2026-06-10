# Monorepo CI & Release System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive version bump script and GitHub CI publish workflow for the pi-stef monorepo, enabling per-package npm publishing.

**Architecture:** A local Node.js script (`scripts/release.mjs`) handles interactive package selection, version bumping, changelog updates, test gating, git commit, tagging, and pushing. A thin GitHub Actions workflow triggers on tag push to publish the tagged package to npm.

**Tech Stack:** Node.js (ESM, built-ins only), pnpm workspaces, GitHub Actions, npm

**Design note — Raw TypeScript publishing:** Packages intentionally publish raw `.ts` source files with no build/compile step. The `exports` field points to `./src/index.ts` and `files` includes `src/`. This is by design — consumers of these packages (Pi extensions) load TypeScript directly. This matches the rpiv-mono pattern. The CI workflow has no build step.

**Prerequisites — GitHub repository setup:**
- Create an npm access token with publish scope for `@pi-stef`
- Add it as a GitHub repository secret named `NPM_TOKEN` (Settings → Secrets → Actions)
- Ensure the repository has GitHub Actions enabled

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

- [ ] **Step 2: Verify**

Run: `ls -la packages/*/CHANGELOG.md`

Expected: 8 files.

- [ ] **Step 3: Commit**

```bash
git add packages/*/CHANGELOG.md
git commit -m "docs(changelog): add CHANGELOG.md to all packages"
```

---

## Milestone 2: Release Script

### Task 2: Script skeleton with package discovery

**Files:**
- Create: `scripts/release.mjs`

- [ ] **Step 1: Create the script**

```javascript
#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";

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

/**
 * Prompt the user with a question and return their answer.
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

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

// --- Main ---
async function main() {
  const pkgs = discoverPackages();
  if (pkgs.length === 0) {
    console.error("No packages found.");
    process.exit(1);
  }

  console.log("Discovered packages:");
  for (const pkg of pkgs) {
    console.log(`  ${pkg.name} (${pkg.version})`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Test**

Run: `node scripts/release.mjs`

Expected: Lists all 8 packages with versions.

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add script skeleton with package discovery"
```

---

### Task 3: Interactive menu — package selection

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add selectPackage function**

Add after `run()`:

```javascript
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

  if (answer === "q" || answer === "Q") return null;
  if (answer === "all") return packages;

  const index = parseInt(answer, 10);
  if (isNaN(index) || index < 1 || index > packages.length) {
    console.error(`Invalid choice: "${answer}"`);
    process.exit(1);
  }

  return [packages[index - 1]];
}
```

- [ ] **Step 2: Wire into main()**

Replace the body of `main()` (after `discoverPackages`) with:

```javascript
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selected = await selectPackage(rl, pkgs);

  if (!selected) {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  console.log(`\nSelected: ${selected.map((p) => p.dirName).join(", ")}`);

  // [TASK-7-PREFLIGHT] Pre-flight checks (Task 7)
  // [TASK-4-BUMP] Bump type selection and preview (Task 4)
  // [TASK-5-UPDATE] Version update (Task 5)
  // [TASK-6-CHANGELOG] Changelog update (Task 6)
  // [TASK-8-GIT] Git operations (Task 8)

  rl.close();
```

**Note:** Each subsequent task replaces its labeled `[TASK-N-...]` comment with actual code.

- [ ] **Step 3: Test**

Run: `echo "1" | node scripts/release.mjs` → selects agent-workflows
Run: `echo "all" | node scripts/release.mjs` → selects all
Run: `echo "q" | node scripts/release.mjs` → prints Aborted

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add interactive package selection menu"
```

---

### Task 4: Bump type selection and version calculation

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add bump type selection and semver calculation**

Add after `selectPackage`:

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
    case "1": return "patch";
    case "2": return "minor";
    case "3": return "major";
    default:
      if (["patch", "minor", "major"].includes(answer)) return answer;
      console.error(`Invalid bump type: "${answer}"`);
      process.exit(1);
  }
}

/**
 * Calculate the new version given a current version and bump type.
 */
function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version format: "${version}"`);

  let [, major, minor, patch] = match.map(Number);

  switch (type) {
    case "major": major += 1; minor = 0; patch = 0; break;
    case "minor": minor += 1; patch = 0; break;
    case "patch": patch += 1; break;
  }

  return `${major}.${minor}.${patch}`;
}
```

- [ ] **Step 2: Wire into main()**

Replace `// [TASK-4-BUMP] Bump type selection and preview (Task 4)` with:

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
```

- [ ] **Step 3: Test version calculation**

Run: `node --check scripts/release.mjs` — syntax OK.

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add bump type selection and version calculation"
```

---

### Task 5: Version update, dependency conversion, and private flag removal

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add dependency conversion and batch update functions**

Add after `bumpVersion`:

```javascript
/**
 * Convert file: protocol dependencies to published version ranges.
 * Uses versionMap (name → newVersion) to resolve cross-package deps.
 */
function convertFileDependencies(pkg, versionMap) {
  const depFields = ["dependencies", "devDependencies"];
  for (const field of depFields) {
    if (!pkg[field]) continue;
    for (const [depName, depValue] of Object.entries(pkg[field])) {
      if (typeof depValue === "string" && depValue.startsWith("file:")) {
        const newVer = versionMap.get(depName);
        if (newVer) pkg[field][depName] = `^${newVer}`;
      }
    }
  }
}

/**
 * Update all package.json files for the given releases.
 * Builds version map with NEW versions first, then updates each package.
 * This ensures cross-package deps reference the new version, not the old one.
 */
function updateAllPackageVersions(releases) {
  const versionMap = new Map(releases.map((r) => [r.name, r.newVersion]));

  for (const r of releases) {
    const raw = readFileSync(r.pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    pkg.version = r.newVersion;
    if (pkg.private) delete pkg.private;
    convertFileDependencies(pkg, versionMap);
    writeFileSync(r.pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }
}
```

- [ ] **Step 2: Wire into main()**

Replace `// [TASK-5-UPDATE] Version update (Task 5)` with:

```javascript
  // Update package.json files (version + deps + private flag)
  updateAllPackageVersions(releases);
  for (const r of releases) {
    console.log(`  Updated ${r.dirName}/package.json`);
  }
```

- [ ] **Step 3: Test**

Run: `echo -e "1\npatch\ny" | node scripts/release.mjs`

Verify: `git diff packages/agent-workflows/package.json` — version changed, private removed.

Revert: `git checkout -- packages/agent-workflows/package.json`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add version update with dep conversion and private flag removal"
```

---

### Task 6: Changelog update logic

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add changelog update function**

Add after `updateAllPackageVersions`:

```javascript
/**
 * Update a package's CHANGELOG.md with a new version entry.
 * If the file doesn't exist, creates it.
 * If [Unreleased] section exists, replaces it with the new version + fresh [Unreleased].
 * If [Unreleased] is missing, inserts the new version after the header.
 */
function updateChangelog(pkgDir, newVersion) {
  const changelogPath = join(PACKAGES_DIR, pkgDir, "CHANGELOG.md");
  const today = new Date().toISOString().split("T")[0];

  const newEntry = `## [Unreleased]

## [${newVersion}] - ${today}
### Changed
- Version bump
`;

  if (!existsSync(changelogPath)) {
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
    content = content.replace("## [Unreleased]", newEntry);
  } else {
    const headerEnd = content.indexOf("\n", content.indexOf("# Changelog"));
    if (headerEnd !== -1) {
      content =
        content.slice(0, headerEnd + 1) + "\n" + newEntry + "\n" + content.slice(headerEnd + 1);
    } else {
      content = newEntry + "\n" + content;
    }
  }

  writeFileSync(changelogPath, content, "utf-8");
}
```

- [ ] **Step 2: Wire into main()**

Replace `// [TASK-6-CHANGELOG] Changelog update (Task 6)` with:

```javascript
  // Update changelogs
  for (const r of releases) {
    updateChangelog(r.dirName, r.newVersion);
    console.log(`  Updated ${r.dirName}/CHANGELOG.md`);
  }
```

- [ ] **Step 3: Test**

Run: `echo -e "1\npatch\ny" | node scripts/release.mjs`

Check: `head -15 packages/agent-workflows/CHANGELOG.md` — shows `## [0.2.1]` section.

Revert: `git checkout -- packages/agent-workflows/package.json packages/agent-workflows/CHANGELOG.md`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add changelog update logic"
```

---

### Task 7: Pre-flight checks

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add pre-flight check functions**

Add after `updateChangelog`:

```javascript
/**
 * Check that the git working directory is clean.
 */
function assertCleanWorkingDir() {
  const status = run("git status --porcelain", { silent: true });
  if (status.length > 0) {
    console.error("\n❌ Working directory is not clean. Commit or stash changes first.");
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

/**
 * Check that local branch is in sync with remote.
 */
function assertInSyncWithRemote() {
  const branch = run("git rev-parse --abbrev-ref HEAD");
  try {
    run(`git fetch origin ${branch}`, { silent: true });
    const local = run(`git rev-parse ${branch}`);
    const remote = run(`git rev-parse origin/${branch}`);
    if (local !== remote) {
      console.error(`\n❌ Local ${branch} is not in sync with origin/${branch}. Pull first.`);
      process.exit(1);
    }
  } catch {
    // Remote branch may not exist yet — OK
  }
}

/**
 * Rollback changes if the release fails mid-way.
 * Resets modified files and deletes any tags created in this session.
 */
function rollback(releases, createdTags) {
  console.error("\n⚠️  Rolling back changes...");
  const files = releases
    .map((r) => `packages/${r.dirName}/package.json packages/${r.dirName}/CHANGELOG.md`)
    .join(" ");
  try { run(`git checkout -- ${files}`, { silent: true }); } catch {}
  for (const tag of createdTags) {
    try { run(`git tag -d "${tag}"`, { silent: true }); } catch {}
  }
}
```

- [ ] **Step 2: Wire into main()**

Replace `// [TASK-7-PREFLIGHT] Pre-flight checks (Task 7)` with:

```javascript
  // Pre-flight checks
  assertCleanWorkingDir();
  assertInSyncWithRemote();
  runTests();
```

- [ ] **Step 3: Test dirty check**

Run: `touch dirty-test-file && echo "1" | node scripts/release.mjs`

Expected: `❌ Working directory is not clean.`

Clean up: `rm dirty-test-file`

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add pre-flight checks for dirty dir, tests, and remote sync"
```

---

### Task 8: Git operations — commit, tag, push + dry-run flag

**Files:**
- Modify: `scripts/release.mjs`

- [ ] **Step 1: Add git release function**

Add after `rollback`:

```javascript
/**
 * Stage files, commit, create tags, and push.
 * Pushes only the specific release tags (not all local tags).
 * Detects current branch name instead of hardcoding "main".
 * Returns array of created tag names (for rollback tracking).
 */
function gitRelease(releases, isAll) {
  const files = releases
    .map((r) => `packages/${r.dirName}/package.json packages/${r.dirName}/CHANGELOG.md`)
    .join(" ");

  run(`git add ${files}`);

  const version = releases[0].newVersion;
  const commitMsg = isAll
    ? `release(all): v${version}`
    : `release(${releases[0].dirName}): v${version}`;

  run(`git commit -m "${commitMsg}"`);
  console.log(`\n✅ Committed: ${commitMsg}`);

  const tags = [];
  for (const r of releases) {
    const tag = `${r.name}@${r.newVersion}`;
    run(`git tag "${tag}"`);
    tags.push(tag);
    console.log(`  Tagged: ${tag}`);
  }

  const branch = run("git rev-parse --abbrev-ref HEAD");
  console.log(`\n⏳ Pushing to origin/${branch}...`);
  run(`git push origin ${branch}`);
  for (const tag of tags) {
    run(`git push origin "${tag}"`);
  }
  console.log("✅ Pushed commits and tags.");

  return tags;
}
```

- [ ] **Step 2: Add --dry-run flag to main()**

At the top of `main()`, after `const pkgs = discoverPackages();`, add:

```javascript
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("🔍 DRY RUN mode — no files will be modified, no git operations.\n");
  }
```

Wrap the pre-flight checks in `if (!dryRun)`:

```javascript
  // Pre-flight checks
  if (!dryRun) {
    assertCleanWorkingDir();
    assertInSyncWithRemote();
    runTests();
  }
```

- [ ] **Step 3: Wire git operations and rollback into main()**

Replace `// [TASK-8-GIT] Git operations (Task 8)` with:

```javascript
  // Git commit, tag, push (skip in dry-run)
  if (dryRun) {
    console.log("\n✅ Dry run complete. No changes made.");
    rl.close();
    return;
  }

  let createdTags = [];
  try {
    createdTags = gitRelease(releases, isAll);
    console.log("\n🎉 Release complete!");
    console.log("CI will now publish to npm when tags are processed.");
  } catch (err) {
    rollback(releases, createdTags);
    console.error(`\n❌ Release failed: ${err.message}`);
    console.error("All changes have been rolled back.");
    process.exit(1);
  }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check scripts/release.mjs`

Expected: No output (syntax OK).

- [ ] **Step 5: Test dry-run**

Run: `echo -e "1\npatch\ny" | node scripts/release.mjs --dry-run`

Expected: Shows preview, prints `✅ Dry run complete. No changes made.`

- [ ] **Step 6: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): add git operations, rollback, and --dry-run flag"
```

---

## Milestone 3: CI Workflow

### Task 9: Create GitHub Actions publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] **Step 1: Create directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write the workflow**

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
          PKG_NAME="${TAG%@*}"
          VERSION="${TAG##*@}"
          PKG_DIR="${PKG_NAME#@pi-stef/}"

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

          CHANGELOG_FILE="packages/${PKG_DIR}/CHANGELOG.md"
          if [ -f "$CHANGELOG_FILE" ]; then
            ESCAPED_VERSION="${VERSION//./\\.}"
            BODY=$(sed -n "/^## \[${ESCAPED_VERSION}\]/,/^## \[/p" "$CHANGELOG_FILE" | sed '$d')
          else
            BODY="Release ${VERSION}"
          fi

          gh release create "$TAG" \
            --title "${PKG_DIR} v${VERSION}" \
            --notes "$BODY"
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add publish workflow for npm releases"
```

---

## Milestone 4: Root Configuration

### Task 10: Add release script alias

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

In root `package.json`, add `"release"` to `scripts`:

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

- [ ] **Step 2: Verify**

Run: `echo "q" | pnpm release`

Expected: Shows menu, prints `Aborted.`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add release script alias to root package.json"
```

---

## Final Verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test` — Expected: All pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck` — Expected: No errors.

- [ ] **Step 3: Verify dry-run flow**

```bash
echo -e "1\npatch\ny" | node scripts/release.mjs --dry-run
```

Expected: Shows preview, prints `✅ Dry run complete. No changes made.`

```bash
echo -e "all\nminor\ny" | node scripts/release.mjs --dry-run
```

Expected: Shows all packages bumping 0.2.0 → 0.3.0, dry run completes.
