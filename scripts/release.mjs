#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { bumpVersion, convertFileDependencies, sanitize } from "./lib.mjs";

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
  return (execSync(cmd, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: opts.silent ? "pipe" : "inherit",
    ...opts,
  }) ?? "").trim();
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

  if (answer === "q" || answer === "Q") return null;
  if (answer === "all") return packages;

  const index = parseInt(answer, 10);
  if (isNaN(index) || index < 1 || index > packages.length) {
    console.error(`Invalid choice: "${answer}"`);
    process.exit(1);
  }

  return [packages[index - 1]];
}

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
 * If a commit was made, resets it with --soft HEAD~1.
 * Restores files from HEAD (not index) and deletes any tags created in this session.
 */
function rollback(releases, createdTags) {
  console.error("\n⚠️  Rolling back changes...");

  // If tags were created, a commit was made — undo it
  if (createdTags.length > 0) {
    try { run("git reset --soft HEAD~1", { silent: true }); } catch {}
  }

  // Restore files from HEAD
  const files = releases
    .map((r) => `packages/${r.dirName}/package.json packages/${r.dirName}/CHANGELOG.md`)
    .join(" ");
  try { run(`git checkout HEAD -- ${files} pnpm-lock.yaml`, { silent: true }); } catch {}

  // Delete any tags created in this session
  for (const tag of createdTags) {
    try { run(`git tag -d "${tag}"`, { silent: true }); } catch {}
  }
}

/**
 * Stage files, commit, create tags, and push.
 * Pushes only the specific release tags (not all local tags).
 * Detects current branch name instead of hardcoding "main".
 * Returns array of created tag names (for rollback tracking).
 *
 * @param {Array} releases - packages to release
 * @param {boolean} isAll - whether this is an "all packages" release
 * @param {string[]} createdTags - mutable array; tags are pushed as they are created
 *                                 so rollback() can see them even if push fails mid-way.
 */
function gitRelease(releases, isAll, createdTags) {
  const files = releases
    .map((r) => `packages/${r.dirName}/package.json packages/${r.dirName}/CHANGELOG.md`)
    .join(" ");

  run(`git add ${files} pnpm-lock.yaml`);

  const version = releases[0].newVersion;
  const commitMsg = sanitize(
    isAll ? `release(all): v${version}` : `release(${releases[0].dirName}): v${version}`
  );

  run(`git commit -m "${commitMsg}"`);
  console.log(`\n✅ Committed: ${commitMsg}`);

  for (const r of releases) {
    const tag = sanitize(`${r.name}@${r.newVersion}`);
    assertTagDoesNotExist(tag);
    run(`git tag "${tag}"`);
    createdTags.push(tag);
    console.log(`  Tagged: ${tag}`);
  }

  const branch = run("git rev-parse --abbrev-ref HEAD");
  console.log(`\n⏳ Pushing to origin/${branch}...`);
  run(`git push origin ${branch}`);
  for (const tag of createdTags) {
    run(`git push origin "${tag}"`);
  }
  console.log("✅ Pushed commits and tags.");
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
  const selected = await selectPackage(rl, pkgs);

  if (!selected) {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  console.log(`\nSelected: ${selected.map((p) => p.dirName).join(", ")}`);

  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("🔍 DRY RUN mode — no files will be modified, no git operations.\n");
  }

  // Pre-flight checks (skip in dry-run)
  if (!dryRun) {
    assertCleanWorkingDir();
    assertInSyncWithRemote();
    runTests();
  }

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

  // Update package.json files (version + deps + private flag)
  if (!dryRun) {
    updateAllPackageVersions(releases);
    for (const r of releases) {
      console.log(`  Updated ${r.dirName}/package.json`);
    }

    // Sync lockfile with updated deps (file: → ^version)
    console.log("\n⏳ Syncing lockfile...");
    run("pnpm install --no-frozen-lockfile");
    console.log("✅ Lockfile synced.");
  }

  // Update changelogs
  if (!dryRun) {
    for (const r of releases) {
      updateChangelog(r.dirName, r.newVersion);
      console.log(`  Updated ${r.dirName}/CHANGELOG.md`);
    }
  }

  // Dry-run: skip mutations and exit
  if (dryRun) {
    console.log("\n✅ Dry run complete. No changes made.");
    rl.close();
    return;
  }

  // Git commit, tag, push (only reached when NOT dry-run)
  const createdTags = [];
  try {
    gitRelease(releases, isAll, createdTags);
    console.log("\n🎉 Release complete!");
    console.log("CI will now publish to npm when tags are processed.");
  } catch (err) {
    rollback(releases, createdTags);
    console.error(`\n❌ Release failed: ${err.message}`);
    console.error("All changes have been rolled back.");
    process.exit(1);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
