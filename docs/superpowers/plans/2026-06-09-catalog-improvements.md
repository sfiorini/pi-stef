# Catalog Package Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the `@pi-stef/catalog` package with auto-derived names, update command, batch scope operations, and full reset.

**Architecture:** Incremental extension — new subcommands and flags alongside existing ones. Each feature is self-contained in its own command file following the established pattern of `definitions.ts` → `register.ts` → `commands/<name>.ts`.

**Tech Stack:** TypeScript, Vitest, Zod, `@sinclair/typebox` (for LLM tool schemas), `pi install`/`pi uninstall`/`pi update` CLI wrappers.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/commands/definitions.ts` | Modify | Add `update`, `reset` subcommand defs |
| `src/commands/add.ts` | Modify | Auto-derive name from source, add `--scope` support |
| `src/commands/remove.ts` | Modify | Add `--scope` support |
| `src/commands/update.ts` | **Create** | `ct update` command handler |
| `src/commands/reset.ts` | **Create** | `ct reset` command handler |
| `src/catalog/packages.ts` | **Create** | Hardcoded `@pi-stef/*` package list |
| `src/register.ts` | Modify | Update `ct_add`/`ct_remove` schemas, add `ct_update` + `ct_reset` tools |
| `src/util/exec.ts` | Modify | Add `piUpdate` wrapper |
| `tests/commands/add.test.ts` | Modify | Update tests for new `ct add <source>` signature |
| `tests/commands/remove.test.ts` | Modify | Add scope tests |
| `tests/commands/update.test.ts` | **Create** | Update command tests |
| `tests/commands/reset.test.ts` | **Create** | Reset command tests |
| `tests/catalog/packages.test.ts` | **Create** | Package list tests |

---

## Milestone 1: Auto-derive name from source (Req 1)

### Task 1.1: Refactor addCommand to derive name from source

**Files:**
- Modify: `packages/catalog/src/commands/add.ts`

- [ ] **Step 1: Write the failing test for auto-derived name**

Add a new test at the end of `tests/commands/add.test.ts`:

```ts
// --- Auto-derived name from source (Req 1) --------------------------------

it("derives package name from npm source using sourceToKey", async () => {
  seedCatalog(tmpDir);
  const { ctx } = makeCtx();

  await addCommand(
    { positional: ["npm:@pi-stef/team"], flags: { rating: "core" } },
    ctx,
  );

  const catalog = readCatalog(tmpDir);
  expect(catalog.packages["@pi-stef/team"]).toEqual({
    source: "npm:@pi-stef/team",
    rating: "core",
  });
});

it("derives package name from git source using sourceToKey", async () => {
  seedCatalog(tmpDir);
  const { ctx, ui } = makeCtx();
  ui.select.mockResolvedValue("skill");

  await addCommand(
    {
      positional: ["git:github.com/user/repo#packages/foo"],
      flags: { rating: "core" },
    },
    ctx,
  );

  // sourceToKey delegates to cleanGitName which preserves #subpath fragments
  const catalog = readCatalog(tmpDir);
  expect(catalog.packages["github.com/user/repo#packages/foo"]).toEqual({
    source: "git:github.com/user/repo#packages/foo",
    rating: "core",
    type: "skill",
  });
});

it("shows legacy warning when old two-arg syntax is used", async () => {
  seedCatalog(tmpDir);
  const { ctx, ui } = makeCtx();

  await addCommand(
    { positional: ["my-pkg", "npm:my-pkg"], flags: { rating: "core" } },
    ctx,
  );

  expect(ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("legacy"),
    "warning",
  );
  // Should still work with the provided name
  const catalog = readCatalog(tmpDir);
  expect(catalog.packages["my-pkg"]).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/add.test.ts`
Expected: New tests fail (legacy warning not emitted, auto-derived name not used)

- [ ] **Step 3: Modify addCommand to auto-derive name**

Replace the `addCommand` function in `src/commands/add.ts`:

```ts
import { sourceToKey } from "../catalog/source.js";

// ... existing imports and helpers ...

export async function addCommand(args: CommandArgs, ctx: AddCtx): Promise<void> {
  const { positional, flags } = args;

  // --- Handle legacy 2-arg syntax: ct add <name> <source> -------------------
  let name: string;
  let source: string;

  if (positional.length >= 2) {
    // Legacy: ct add <name> <source>
    name = positional[0];
    source = positional[1];
    ctx.ui.notify(
      `"ct add <name> <source>" is legacy. Use "ct add <source>" — name is auto-derived.`,
      "warning",
    );
  } else if (positional.length === 1) {
    // New: ct add <source>
    source = positional[0];
    name = sourceToKey(source);
  } else {
    ctx.ui.notify(
      "Usage: ct add <source> [--rating <core|useful|debatable>] [--type <skill|pi-native>]",
      "error",
    );
    return;
  }

  const rating = resolveRating(flags);
  let type = resolveType(flags);

  // --- Read catalog ---------------------------------------------------------
  const catalog = readCatalog(ctx.home);

  // --- Prompt for type when git source and no explicit type -----------------
  if (source.startsWith("git:") && type === undefined) {
    if (ctx.ui.select) {
      type = await ctx.ui.select<"skill" | "pi-native">({
        message: `Select type for "${name}"`,
        choices: [
          { value: "skill", label: "Skill" },
          { value: "pi-native", label: "Pi-native" },
        ],
      });
    }
  }

  // --- Add package ----------------------------------------------------------
  try {
    const updated = addPackage(catalog, name, source, rating, type);
    writeCatalog(updated, ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
    return;
  }

  ctx.ui.notify(`Added "${name}" to catalog`, "info");

  // --- Run pi install -------------------------------------------------------
  try {
    await piInstall(source);
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" added to catalog but install failed`,
      "warning",
    );
  }
}
```

- [ ] **Step 4: Fix existing test that will break**

The existing test `"shows error when source is missing"` passes `positional: ["my-pkg"]` and expects a "Usage" error. Under the new code, a single positional arg enters the auto-derive path, and `addPackage` throws "Invalid source" (not "Usage"). Update the test:

In `tests/commands/add.test.ts`, find:

```ts
  it("shows error when source is missing", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: ["my-pkg"], flags: { rating: "core" } },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });
```

Replace with:

```ts
  it("shows error for invalid source when single positional arg", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: ["my-pkg"], flags: { rating: "core" } },
      ctx,
    );

    // Single positional arg is now treated as source; "my-pkg" is invalid
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid source"),
      "error",
    );
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/add.test.ts`
Expected: All tests pass including new auto-derived name tests and the updated existing test

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/src/commands/add.ts packages/catalog/tests/commands/add.test.ts
git commit -m "feat(ct): auto-derive package name from source in ct add

Name is now derived via sourceToKey() instead of requiring a manual
name parameter. Legacy 2-arg syntax is still supported with a warning.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.2: Update ct_add LLM tool schema

**Files:**
- Modify: `packages/catalog/src/register.ts`

- [ ] **Step 1: Update ct_add tool in register.ts**

In `register.ts`, find the `ct_add` tool registration (the `pi.registerTool` block with `name: "ct_add"`) and replace it:

```ts
  pi.registerTool({
    name: "ct_add",
    label: "Catalog Add",
    description:
      "Add a package to the catalog. Source must start with 'npm:' or 'git:'. The package name is auto-derived from the source.",
    promptSnippet: "Add a package to the catalog",
    promptGuidelines: [
      "Use ct_add when the user asks to add a new package or skill to their catalog.",
      "The name parameter is the source string (e.g. 'npm:@pi-stef/team' or 'git:github.com/user/repo').",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "Package source (npm:… or git:…)" }),
      rating: Type.Optional(Type.String({ description: "Initial rating (core, useful, debatable)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = {
          positional: [params.source],
          flags: params.rating ? { rating: params.rating } : {},
        };
        await addCommand(args, ctx as unknown as AddCtx);
        return { content: [{ type: "text" as const, text: `Added ${params.source}.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Add failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog typecheck`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/src/register.ts
git commit -m "feat(ct): update ct_add LLM tool to use source-only schema

Remove name parameter from ct_add tool — name is now auto-derived.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 2: ct update command (Req 2)

### Task 2.1: Add piUpdate wrapper to exec.ts

**Files:**
- Modify: `packages/catalog/src/util/exec.ts`

- [ ] **Step 1: Add piUpdate function**

Add at the end of `src/util/exec.ts`, before the closing of the file:

```ts
/**
 * Update a pi package by source.
 *
 * Runs `pi update <source>`.
 */
export function piUpdate(
  source: string,
  options?: PiExecOptions,
): Promise<ExecResult> {
  return execCommand("pi", ["update", source], options);
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/catalog/src/util/exec.ts
git commit -m "feat(ct): add piUpdate wrapper to exec utilities

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.2: Register update subcommand definition

**Files:**
- Modify: `packages/catalog/src/commands/definitions.ts`

- [ ] **Step 1: Add update and reset to SUBCOMMAND_DEFS**

In `src/commands/definitions.ts`, add two entries to the `SUBCOMMAND_DEFS` array — `update` after `remove`, and `reset` after `profile`:

```ts
export const SUBCOMMAND_DEFS: readonly SubcommandDef[] = [
  { name: "sync", description: "Sync catalog with remote gist" },
  { name: "init", description: "Initialize a new catalog" },
  { name: "add", aliases: ["a"], description: "Add a package to the catalog" },
  { name: "remove", aliases: ["rm"], description: "Remove a package from the catalog" },
  { name: "update", aliases: ["up"], description: "Update packages to latest versions" },
  { name: "toggle", description: "Toggle a package's rating" },
  { name: "disable", description: "Disable a package" },
  { name: "enable", description: "Enable a package" },
  { name: "push", description: "Push catalog to remote gist" },
  { name: "pull", description: "Pull catalog from remote gist" },
  { name: "login", description: "Authenticate with GitHub for sync" },
  { name: "status", description: "Show catalog status" },
  { name: "diff", description: "Show diff between local and remote catalog" },
  { name: "verify", description: "Verify catalog integrity" },
  { name: "profiles", description: "List available profiles" },
  { name: "profile", description: "Show or switch active profile" },
  { name: "reset", description: "Reset catalog: uninstall all @pi-stef packages and delete config" },
] as const;
```

- [ ] **Step 2: Run existing definitions tests**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/definitions.test.ts`
Expected: All pass (tests check getSubcommandNames length — may need updating)

- [ ] **Step 3: Fix any broken tests**

If the definitions test checks a hardcoded count, update it to reflect the new subcommands.

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/src/commands/definitions.ts packages/catalog/tests/commands/definitions.test.ts
git commit -m "feat(ct): add update and reset subcommand definitions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.3: Create update command handler

**Files:**
- Create: `packages/catalog/src/commands/update.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/update.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import type { CommandCtx } from "../../src/commands/types.js";
import { updateCommand } from "../../src/commands/update.js";
import { writeCatalog, readCatalog, readLock, writeLock } from "../../src/config/io.js";

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-update-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface MockUi {
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<MockUi> = {}): {
  ctx: CommandCtx;
  ui: MockUi;
} {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir } as CommandCtx, ui };
}

function catalogWithPackages(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-pkg": { source: "npm:my-pkg", rating: "core" },
      "another-pkg": { source: "npm:another-pkg", rating: "useful" },
      "git-pkg": {
        source: "git:github.com/user/repo#packages/foo",
        rating: "core",
        type: "skill",
      },
    },
  };
}

function seedCatalog(home: string, catalog?: CatalogYaml): void {
  writeCatalog(catalog ?? catalogWithPackages(), home);
}

describe("updateCommand", () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../../src/util/exec.js");
    updateSpy = vi
      .spyOn(execModule, "piUpdate")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    updateSpy?.mockRestore();
    cleanup();
  });

  // --- Shows usage when no args and no --all --------------------------------

  it("shows usage when no package name and no --all flag", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await updateCommand({ positional: [], flags: {} }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "error",
    );
  });

  // --- Updates a single package ---------------------------------------------

  it("updates a single package by name", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await updateCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(updateSpy).toHaveBeenCalledWith("npm:my-pkg");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-pkg"),
      "info",
    );
  });

  // --- Shows error for unknown package --------------------------------------

  it("shows error when package not in catalog", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await updateCommand(
      { positional: ["nonexistent"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // --- Updates all packages with --all flag ---------------------------------

  it("updates all packages when --all flag is set", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await updateCommand(
      { positional: [], flags: { all: true } },
      ctx,
    );

    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(updateSpy).toHaveBeenCalledWith("npm:my-pkg");
    expect(updateSpy).toHaveBeenCalledWith("npm:another-pkg");
    expect(updateSpy).toHaveBeenCalledWith("git:github.com/user/repo#packages/foo");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("3"),
      "info",
    );
  });

  // --- Continues on individual failure in --all mode ------------------------

  it("continues updating other packages when one fails", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    updateSpy
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(new Error("update failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    await updateCommand(
      { positional: [], flags: { all: true } },
      ctx,
    );

    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      "warning",
    );
  });

  // --- Shows message when --all with no packages ----------------------------

  it("shows message when --all with no packages", async () => {
    const empty: CatalogYaml = { meta: { pi_version: "1.0.0" }, packages: {} };
    seedCatalog(tmpDir, empty);
    const { ctx, ui } = makeCtx();

    await updateCommand(
      { positional: [], flags: { all: true } },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No packages"),
      "info",
    );
  });

  // --- pi update failure is non-fatal for single update ---------------------

  it("notifies on update failure for single package", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    updateSpy.mockRejectedValue(new Error("update failed"));

    await updateCommand(
      { positional: ["my-pkg"], flags: {} },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      "warning",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/update.test.ts`
Expected: Import error — `update.ts` doesn't exist yet

- [ ] **Step 3: Create the update command handler**

Create `src/commands/update.ts`:

```ts
/**
 * `ct update` subcommand implementation.
 *
 * Updates packages to their latest versions. Supports:
 *   - `ct update <name>` — updates one package
 *   - `ct update --all` — updates all catalog packages
 *
 * Runs `pi update <source>` behind the scenes for each package.
 */

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog } from "../config/io.js";
import { piUpdate } from "../util/exec.js";

// ---------------------------------------------------------------------------
// updateCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct update` subcommand.
 *
 * Reads the catalog, resolves packages to update, runs `pi update`
 * for each, and reports results.
 */
export async function updateCommand(
  args: CommandArgs,
  ctx: CommandCtx,
): Promise<void> {
  const { positional, flags } = args;
  const updateAll = "all" in flags;
  const name = positional[0];

  // --- Validate args --------------------------------------------------------
  if (!name && !updateAll) {
    ctx.ui.notify(
      "Usage: ct update <name> | ct update --all",
      "error",
    );
    return;
  }

  // --- Read catalog ---------------------------------------------------------
  const catalog = readCatalog(ctx.home);

  // --- Single package update ------------------------------------------------
  if (name) {
    const entry = catalog.packages[name];
    if (!entry) {
      ctx.ui.notify(`Package "${name}" not found in catalog`, "error");
      return;
    }

    try {
      await piUpdate(entry.source);
      ctx.ui.notify(`Updated "${name}"`, "info");
    } catch {
      ctx.ui.notify(
        `Warning: update of "${name}" failed`,
        "warning",
      );
    }
    return;
  }

  // --- Update all -----------------------------------------------------------
  const names = Object.keys(catalog.packages);
  if (names.length === 0) {
    ctx.ui.notify("No packages to update", "info");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const pkgName of names) {
    const entry = catalog.packages[pkgName];
    try {
      await piUpdate(entry.source);
      successCount++;
    } catch {
      failCount++;
      ctx.ui.notify(
        `Warning: update of "${pkgName}" failed`,
        "warning",
      );
    }
  }

  ctx.ui.notify(
    `Updated ${successCount}/${names.length} packages${failCount > 0 ? ` (${failCount} failed)` : ""}`,
    "info",
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/update.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/src/commands/update.ts packages/catalog/tests/commands/update.test.ts
git commit -m "feat(ct): add ct update command

Supports single package update (ct update <name>) and batch update
(ct update --all). Runs pi update behind the scenes.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.4: Wire update into register.ts (REQUIRED — without this, /ct update is unregistered)

**Files:**
- Modify: `packages/catalog/src/register.ts`

- [ ] **Step 1: Add import and switch case**

In `register.ts`, add the import at the top:

```ts
import { updateCommand } from "./commands/update.js";
```

Add a case in the `handleSubcommand` switch (after the `remove` case):

```ts
    case "update":
      await updateCommand(parsed, ctx);
      break;
```

Add the `ct_update` LLM tool registration after the `ct_status` tool block:

```ts
  pi.registerTool({
    name: "ct_update",
    label: "Catalog Update",
    description:
      "Update packages to their latest versions. Use 'all' to update all packages, or provide a package name.",
    promptSnippet: "Update catalog packages",
    promptGuidelines: [
      "Use ct_update when the user asks to update a package or all packages.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Package name to update" })),
      all: Type.Optional(Type.Boolean({ description: "Update all packages" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = {
          positional: params.name ? [params.name] : [],
          flags: params.all ? { all: true } : {},
        };
        await updateCommand(args, ctx as unknown as CommandCtx);
        return { content: [{ type: "text" as const, text: "Update completed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Update failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog typecheck`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/src/register.ts
git commit -m "feat(ct): wire ct update command and LLM tool

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 3: Scope-based batch operations (Req 3 + Req 5)

### Task 3.1: Create @pi-stef packages constant (packages.ts)

**Files:**
- Create: `packages/catalog/src/catalog/packages.ts` (new file — no prior version exists)
- Create: `packages/catalog/tests/catalog/packages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/catalog/packages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PI_STEF_PACKAGES,
  isPiStefPackage,
  isPiStefSource,
  CATALOG_PACKAGE_NAME,
} from "../../src/catalog/packages.js";

describe("PI_STEF_PACKAGES", () => {
  it("contains all @pi-stef packages except catalog", () => {
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/agent-workflows");
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/atlassian");
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/figma");
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/paths");
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/team");
    expect(PI_STEF_PACKAGES).toContain("@pi-stef/web");
  });

  it("does not include @pi-stef/catalog", () => {
    expect(PI_STEF_PACKAGES).not.toContain("@pi-stef/catalog");
  });
});

describe("isPiStefPackage", () => {
  it("returns true for @pi-stef packages", () => {
    expect(isPiStefPackage("@pi-stef/team")).toBe(true);
  });

  it("returns false for catalog", () => {
    expect(isPiStefPackage("@pi-stef/catalog")).toBe(false);
  });

  it("returns false for non-pi-stef packages", () => {
    expect(isPiStefPackage("lodash")).toBe(false);
  });
});

describe("isPiStefSource", () => {
  it("returns true for npm:@pi-stef/* sources", () => {
    expect(isPiStefSource("npm:@pi-stef/team")).toBe(true);
  });

  it("returns false for catalog source", () => {
    expect(isPiStefSource("npm:@pi-stef/catalog")).toBe(false);
  });

  it("returns false for non-pi-stef sources", () => {
    expect(isPiStefSource("npm:lodash")).toBe(false);
  });
});

describe("CATALOG_PACKAGE_NAME", () => {
  it("is @pi-stef/catalog", () => {
    expect(CATALOG_PACKAGE_NAME).toBe("@pi-stef/catalog");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/catalog/packages.test.ts`
Expected: Import error — module doesn't exist

- [ ] **Step 3: Create the pi-stef-packages module**

Create `src/catalog/packages.ts`:

```ts
/**
 * Hardcoded list of @pi-stef/* packages managed by the catalog.
 *
 * `@pi-stef/catalog` is intentionally excluded — it can only be
 * installed/uninstalled via `pi install`/`pi remove`, not through
 * catalog batch operations.
 */

import { extractNpmName } from "./source.js";

/** The catalog package name (excluded from batch operations). */
export const CATALOG_PACKAGE_NAME = "@pi-stef/catalog";

/**
 * All @pi-stef/* packages except catalog.
 *
 * Used by `ct add --scope @pi-stef` and `ct remove --scope @pi-stef`.
 */
export const PI_STEF_PACKAGES: readonly string[] = [
  "@pi-stef/agent-workflows",
  "@pi-stef/atlassian",
  "@pi-stef/figma",
  "@pi-stef/paths",
  "@pi-stef/team",
  "@pi-stef/web",
] as const;

/**
 * Check if a package name is a @pi-stef package (excluding catalog).
 */
export function isPiStefPackage(name: string): boolean {
  return PI_STEF_PACKAGES.includes(name);
}

/**
 * Check if a source string points to a @pi-stef package (excluding catalog).
 *
 * - For npm sources: extracts the package name via `extractNpmName` and checks
 *   it is in PI_STEF_PACKAGES AND is not CATALOG_PACKAGE_NAME.
 * - For non-npm sources (git, local): checks if the source string itself is
 *   in PI_STEF_PACKAGES (which already excludes catalog by definition).
 *
 * Returns `false` for `@pi-stef/catalog` under all source types.
 */
export function isPiStefSource(source: string): boolean {
  if (source.startsWith("npm:")) {
    const pkgName = extractNpmName(source.slice(4));
    // Explicit exclusion: catalog must never be matched by batch operations
    if (pkgName === CATALOG_PACKAGE_NAME) return false;
    return PI_STEF_PACKAGES.includes(pkgName);
  }
  // For non-npm sources, check if the source matches a known @pi-stef package.
  // PI_STEF_PACKAGES does not include catalog, so it is excluded by definition.
  return PI_STEF_PACKAGES.includes(source);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/catalog/packages.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/src/catalog/packages.ts packages/catalog/tests/catalog/packages.test.ts
git commit -m "feat(ct): add @pi-stef package list for batch operations

Hardcoded list of @pi-stef packages excluding catalog. Used by
--scope flag for batch add/remove operations.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.2: Add --scope support to ct add

**Files:**
- Modify: `packages/catalog/src/commands/add.ts`

- [ ] **Step 1: Write the failing tests**

Add at the end of `tests/commands/add.test.ts`:

```ts
// --- --scope @pi-stef batch add (Req 3) -----------------------------------

describe("ct add --scope @pi-stef", () => {
  it("adds all @pi-stef packages except catalog", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: [], flags: { scope: "@pi-stef" } },
      ctx,
    );

    const catalog = readCatalog(tmpDir);
    // Should have all @pi-stef packages except catalog
    expect(catalog.packages["@pi-stef/team"]).toBeDefined();
    expect(catalog.packages["@pi-stef/atlassian"]).toBeDefined();
    expect(catalog.packages["@pi-stef/figma"]).toBeDefined();
    expect(catalog.packages["@pi-stef/paths"]).toBeDefined();
    expect(catalog.packages["@pi-stef/agent-workflows"]).toBeDefined();
    expect(catalog.packages["@pi-stef/web"]).toBeDefined();
    // Catalog should NOT be added
    expect(catalog.packages["@pi-stef/catalog"]).toBeUndefined();
    // Should have called piInstall for each
    expect(installSpy).toHaveBeenCalledTimes(6);
  });

  it("skips packages already in catalog", async () => {
    const existing: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "@pi-stef/team": { source: "npm:@pi-stef/team", rating: "core" },
      },
    };
    seedCatalog(tmpDir, existing);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: [], flags: { scope: "@pi-stef" } },
      ctx,
    );

    // team should be skipped (already exists), 5 others added
    expect(installSpy).toHaveBeenCalledTimes(5);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("skipping"),
      "info",
    );
  });

  it("shows error for unsupported scope", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await addCommand(
      { positional: [], flags: { scope: "@unknown" } },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported scope"),
      "error",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/add.test.ts`
Expected: New scope tests fail

- [ ] **Step 3: Add scope support to addCommand**

In `src/commands/add.ts`, add the import at the top:

```ts
import { PI_STEF_PACKAGES } from "../catalog/packages.js";
```

Replace the `addCommand` function body — add scope handling right after the args destructuring:

```ts
export async function addCommand(args: CommandArgs, ctx: AddCtx): Promise<void> {
  const { positional, flags } = args;

  // --- Handle --scope batch mode --------------------------------------------
  if ("scope" in flags) {
    const scope = flags["scope"];
    if (scope !== "@pi-stef") {
      ctx.ui.notify(`Unsupported scope: "${scope}". Use --scope @pi-stef.`, "error");
      return;
    }

    const catalog = readCatalog(ctx.home);
    let added = 0;
    let skipped = 0;

    for (const pkgName of PI_STEF_PACKAGES) {
      if (catalog.packages[pkgName]) {
        skipped++;
        ctx.ui.notify(`Skipping "${pkgName}" — already in catalog`, "info");
        continue;
      }

      const source = `npm:${pkgName}`;
      try {
        const updated = addPackage(catalog, pkgName, source, "core");
        // Mutate the in-memory catalog so the next iteration sees the addition
        catalog.packages[pkgName] = updated.packages[pkgName];
        writeCatalog(catalog, ctx.home);
        added++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to add "${pkgName}": ${message}`, "warning");
        continue;
      }

      try {
        await piInstall(source);
      } catch {
        ctx.ui.notify(
          `Warning: package "${pkgName}" added to catalog but install failed`,
          "warning",
        );
      }
    }

    ctx.ui.notify(
      `Scope @pi-stef: added ${added}, skipped ${skipped}`,
      "info",
    );
    return;
  }

  // --- Single package mode --------------------------------------------------
  let name: string;
  let source: string;

  if (positional.length >= 2) {
    name = positional[0];
    source = positional[1];
    ctx.ui.notify(
      `"ct add <name> <source>" is legacy. Use "ct add <source>" — name is auto-derived.`,
      "warning",
    );
  } else if (positional.length === 1) {
    source = positional[0];
    name = sourceToKey(source);
  } else {
    ctx.ui.notify(
      "Usage: ct add <source> [--rating <core|useful|debatable>] [--type <skill|pi-native>]",
      "error",
    );
    return;
  }

  const rating = resolveRating(flags);
  let type = resolveType(flags);

  const catalog = readCatalog(ctx.home);

  if (source.startsWith("git:") && type === undefined) {
    if (ctx.ui.select) {
      type = await ctx.ui.select<"skill" | "pi-native">({
        message: `Select type for "${name}"`,
        choices: [
          { value: "skill", label: "Skill" },
          { value: "pi-native", label: "Pi-native" },
        ],
      });
    }
  }

  try {
    const updated = addPackage(catalog, name, source, rating, type);
    writeCatalog(updated, ctx.home);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(message, "error");
    return;
  }

  ctx.ui.notify(`Added "${name}" to catalog`, "info");

  try {
    await piInstall(source);
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" added to catalog but install failed`,
      "warning",
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/add.test.ts`
Expected: All tests pass including scope tests

- [ ] **Step 5: Update ct_add LLM tool to include scope parameter**

In `register.ts`, find the `ct_add` tool and update the parameters and execute handler:

```ts
  pi.registerTool({
    name: "ct_add",
    label: "Catalog Add",
    description:
      "Add a package to the catalog. Source must start with 'npm:' or 'git:'. The package name is auto-derived from the source. Use scope to batch-add all @pi-stef packages.",
    promptSnippet: "Add a package to the catalog",
    promptGuidelines: [
      "Use ct_add when the user asks to add a new package or skill to their catalog.",
      "Use scope='@pi-stef' to add all @pi-stef packages at once.",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "Package source (npm:… or git:…). Required unless scope is set." })),
      rating: Type.Optional(Type.String({ description: "Initial rating (core, useful, debatable)" })),
      scope: Type.Optional(Type.String({ description: "Batch scope, e.g. '@pi-stef'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const positional = params.source ? [params.source] : [];
        const flags: Record<string, true | string> = {};
        if (params.rating) flags.rating = params.rating;
        if (params.scope) flags.scope = params.scope;
        const args: CommandArgs = { positional, flags };
        await addCommand(args, ctx as unknown as AddCtx);
        return { content: [{ type: "text" as const, text: `Add completed.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Add failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
```

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/src/commands/add.ts packages/catalog/tests/commands/add.test.ts packages/catalog/src/register.ts
git commit -m "feat(ct): add --scope @pi-stef support to ct add

Batch add all @pi-stef packages (excluding catalog) with
ct add --scope @pi-stef. Skips packages already in catalog.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.3: Add --scope support to ct remove

**Files:**
- Modify: `packages/catalog/src/commands/remove.ts`

- [ ] **Step 1: Write the failing tests**

Add at the end of `tests/commands/remove.test.ts`:

```ts
// --- --scope @pi-stef batch remove (Req 3) ---------------------------------

describe("ct remove --scope @pi-stef", () => {
  it("removes all @pi-stef packages from catalog (not catalog itself)", async () => {
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "@pi-stef/team": { source: "npm:@pi-stef/team", rating: "core" },
        "@pi-stef/atlassian": { source: "npm:@pi-stef/atlassian", rating: "core" },
        "@pi-stef/catalog": { source: "npm:@pi-stef/catalog", rating: "core" },
        "third-party": { source: "npm:third-party", rating: "useful" },
      },
    };
    seedCatalog(tmpDir, catalog);
    const { ctx, ui } = makeCtx();

    const execModule = await import("../../src/util/exec.js");
    const uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await removeCommand(
      { positional: [], flags: { scope: "@pi-stef" } },
      ctx,
    );

    const result = readCatalog(tmpDir);
    // @pi-stef packages should be removed
    expect(result.packages["@pi-stef/team"]).toBeUndefined();
    expect(result.packages["@pi-stef/atlassian"]).toBeUndefined();
    // Catalog should be untouched
    expect(result.packages["@pi-stef/catalog"]).toBeDefined();
    // Third-party should be untouched
    expect(result.packages["third-party"]).toBeDefined();
    // Should have called piUninstall for the 2 removed packages
    expect(uninstallSpy).toHaveBeenCalledTimes(2);
    uninstallSpy.mockRestore();
  });

  it("shows message when no @pi-stef packages in catalog", async () => {
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "third-party": { source: "npm:third-party", rating: "useful" },
      },
    };
    seedCatalog(tmpDir, catalog);
    const { ctx, ui } = makeCtx();

    await removeCommand(
      { positional: [], flags: { scope: "@pi-stef" } },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No @pi-stef packages"),
      "info",
    );
  });

  it("shows error for unsupported scope", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await removeCommand(
      { positional: [], flags: { scope: "@unknown" } },
      ctx,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported scope"),
      "error",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/remove.test.ts`
Expected: New scope tests fail

- [ ] **Step 3: Add scope support to removeCommand**

In `src/commands/remove.ts`, add the import:

```ts
import { isPiStefSource } from "../catalog/packages.js";
```

Replace the `removeCommand` function body:

```ts
export async function removeCommand(
  args: CommandArgs,
  ctx: RemoveCtx,
): Promise<void> {
  const { positional, flags } = args;

  // --- Handle --scope batch mode --------------------------------------------
  if ("scope" in flags) {
    const scope = flags["scope"];
    if (scope !== "@pi-stef") {
      ctx.ui.notify(`Unsupported scope: "${scope}". Use --scope @pi-stef.`, "error");
      return;
    }

    const catalog = readCatalog(ctx.home);
    // isPiStefSource returns false for @pi-stef/catalog by design (see packages.ts)
    const piStefNames = Object.keys(catalog.packages).filter(
      (name) => isPiStefSource(catalog.packages[name].source),
    );

    if (piStefNames.length === 0) {
      ctx.ui.notify("No @pi-stef packages found in catalog", "info");
      return;
    }

    // Confirm unless --yes
    const skipConfirm = "yes" in flags || "y" in flags;
    if (!skipConfirm && ctx.ui.confirm) {
      const confirmed = await ctx.ui.confirm(
        `Remove ${piStefNames.length} @pi-stef packages from catalog?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Removal cancelled", "info");
        return;
      }
    }

    let removed = 0;
    const lock = readLock(ctx.home);

    for (const name of piStefNames) {
      const source = catalog.packages[name].source;

      // Remove from in-memory catalog
      delete catalog.packages[name];

      // Remove from lock
      delete lock.packages[name];

      removed++;

      try {
        await piUninstall(source);
      } catch {
        ctx.ui.notify(
          `Warning: package "${name}" removed from catalog but uninstall failed`,
          "warning",
        );
      }
    }

    // Write once after all removals
    writeCatalog(catalog, ctx.home);
    writeLock(lock, ctx.home);

    ctx.ui.notify(`Removed ${removed} @pi-stef packages from catalog`, "info");
    return;
  }

  // --- Single package mode --------------------------------------------------
  const name = positional[0];

  if (!name) {
    ctx.ui.notify("Usage: ct remove <name> [--yes]", "error");
    return;
  }

  const catalog = readCatalog(ctx.home);

  if (!catalog.packages[name]) {
    ctx.ui.notify(`Package "${name}" not found`, "error");
    return;
  }

  const skipConfirm = "yes" in flags || "y" in flags;
  if (!skipConfirm) {
    if (ctx.ui.confirm) {
      const confirmed = await ctx.ui.confirm(
        `Remove package "${name}" from catalog?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Removal cancelled", "info");
        return;
      }
    }
  }

  const source = catalog.packages[name].source;

  const updated = removePackage(catalog, name);
  writeCatalog(updated, ctx.home);

  const lock = readLock(ctx.home);
  if (lock.packages[name]) {
    delete lock.packages[name];
    writeLock(lock, ctx.home);
  }

  ctx.ui.notify(`Removed "${name}" from catalog`, "info");

  try {
    await piUninstall(source);
  } catch {
    ctx.ui.notify(
      `Warning: package "${name}" removed from catalog but uninstall failed`,
      "warning",
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/remove.test.ts`
Expected: All tests pass including scope tests

- [ ] **Step 5: Update ct_remove LLM tool to include scope parameter**

In `register.ts`, find the `ct_remove` tool and update:

```ts
  pi.registerTool({
    name: "ct_remove",
    label: "Catalog Remove",
    description: "Remove a package from the catalog by name. Use scope to batch-remove all @pi-stef packages.",
    promptSnippet: "Remove a package from the catalog",
    promptGuidelines: [
      "Use ct_remove when the user asks to remove or uninstall a package from their catalog.",
      "Use scope='@pi-stef' to remove all @pi-stef packages at once.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Package name to remove. Required unless scope is set." })),
      scope: Type.Optional(Type.String({ description: "Batch scope, e.g. '@pi-stef'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const positional = params.name ? [params.name] : [];
        const flags: Record<string, true | string> = {};
        if (params.scope) flags.scope = params.scope;
        const args: CommandArgs = { positional, flags };
        await removeCommand(args, ctx as unknown as RemoveCtx);
        return { content: [{ type: "text" as const, text: `Remove completed.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Remove failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
```

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/src/commands/remove.ts packages/catalog/tests/commands/remove.test.ts packages/catalog/src/register.ts
git commit -m "feat(ct): add --scope @pi-stef support to ct remove

Batch remove all @pi-stef packages (excluding catalog) with
ct remove --scope @pi-stef. Auto-skips catalog package.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 4: ct reset command (Req 4)

### Task 4.1: Create reset command handler

**Files:**
- Create: `packages/catalog/src/commands/reset.ts`
- Create: `packages/catalog/tests/commands/reset.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/reset.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CatalogYaml } from "../../src/config/schema.js";
import type { CommandCtx } from "../../src/commands/types.js";
import { resetCommand } from "../../src/commands/reset.js";
import { writeCatalog, readCatalog } from "../../src/config/io.js";
import { catalogFile, lockFile, catalogDir } from "../../src/config/paths.js";

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-reset-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface MockUi {
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<MockUi> = {}): {
  ctx: CommandCtx;
  ui: MockUi;
} {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir } as CommandCtx, ui };
}

function catalogWithPiStef(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "@pi-stef/team": { source: "npm:@pi-stef/team", rating: "core" },
      "@pi-stef/atlassian": { source: "npm:@pi-stef/atlassian", rating: "core" },
      "@pi-stef/catalog": { source: "npm:@pi-stef/catalog", rating: "core" },
      "third-party": { source: "npm:third-party", rating: "useful" },
    },
  };
}

function seedCatalog(home: string, catalog?: CatalogYaml): void {
  writeCatalog(catalog ?? catalogWithPiStef(), home);
}

describe("resetCommand", () => {
  let uninstallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../../src/util/exec.js");
    uninstallSpy = vi
      .spyOn(execModule, "piUninstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    uninstallSpy?.mockRestore();
    cleanup();
  });

  // --- Confirms before resetting -------------------------------------------

  it("prompts for confirmation before resetting", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: {} }, ctx);

    expect(ui.confirm).toHaveBeenCalledWith(expect.stringContaining("@pi-stef"));
  });

  // --- Does not reset when user declines -----------------------------------

  it("does not reset when user declines confirmation", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(false);

    await resetCommand({ positional: [], flags: {} }, ctx);

    // Catalog should be unchanged
    const catalog = readCatalog(tmpDir);
    expect(Object.keys(catalog.packages)).toHaveLength(4);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
      "info",
    );
  });

  // --- Uninstalls @pi-stef packages and deletes config files ---------------

  it("uninstalls @pi-stef packages and deletes config files", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();
    ui.confirm.mockResolvedValue(true);

    await resetCommand({ positional: [], flags: {} }, ctx);

    // Should have uninstalled 2 @pi-stef packages (not catalog, not third-party)
    expect(uninstallSpy).toHaveBeenCalledTimes(2);
    expect(uninstallSpy).toHaveBeenCalledWith("npm:@pi-stef/team");
    expect(uninstallSpy).toHaveBeenCalledWith("npm:@pi-stef/atlassian");

    // Config files should be deleted
    expect(fs.existsSync(catalogFile(tmpDir))).toBe(false);
    expect(fs.existsSync(lockFile(tmpDir))).toBe(false);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("2"),
      "info",
    );
  });

  // --- Skips confirmation with --yes flag ----------------------------------

  it("skips confirmation when --yes flag is provided", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(uninstallSpy).toHaveBeenCalledTimes(2);
  });

  // --- Handles gracefully when cat.yaml does not exist ---------------------

  it("handles gracefully when cat.yaml does not exist", async () => {
    const { ctx, ui } = makeCtx();

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No catalog"),
      "info",
    );
    expect(uninstallSpy).not.toHaveBeenCalled();
  });

  // --- Continues if uninstall fails ----------------------------------------

  it("continues if one uninstall fails", async () => {
    seedCatalog(tmpDir);
    const { ctx, ui } = makeCtx();

    uninstallSpy
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(new Error("uninstall failed"));

    await resetCommand({ positional: [], flags: { yes: true } }, ctx);

    // Should still delete config files
    expect(fs.existsSync(catalogFile(tmpDir))).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      "warning",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/reset.test.ts`
Expected: Import error — `reset.ts` doesn't exist

- [ ] **Step 3: Create the reset command handler**

Create `src/commands/reset.ts`:

```ts
/**
 * `ct reset` subcommand implementation.
 *
 * Full nuke: uninstalls all @pi-stef packages (except catalog),
 * deletes gist remote + local cache, deletes cat.yaml and lock file.
 */

import fs from "node:fs";
import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog } from "../config/io.js";
import { catalogFile, lockFile, catalogDir } from "../config/paths.js";
import { isPiStefSource } from "../catalog/packages.js";
import { piUninstall } from "../util/exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `resetCommand`, extending the base with `confirm`. */
export interface ResetCtx extends CommandCtx {
  ui: CommandCtx["ui"] & {
    confirm?: (message: string) => Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// resetCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct reset` subcommand.
 *
 * 1. Read cat.yaml — find all @pi-stef/* packages (not catalog)
 * 2. Run pi uninstall for each
 * 3. Delete config files (cat.yaml, catalog.lock.json, .gist)
 */
export async function resetCommand(
  args: CommandArgs,
  ctx: ResetCtx,
): Promise<void> {
  const { flags } = args;

  // --- Check if catalog exists -----------------------------------------------
  const catPath = catalogFile(ctx.home);
  if (!fs.existsSync(catPath)) {
    ctx.ui.notify("No catalog found — nothing to reset", "info");
    return;
  }

  // --- Confirmation ----------------------------------------------------------
  const skipConfirm = "yes" in flags || "y" in flags;
  if (!skipConfirm && ctx.ui.confirm) {
    const confirmed = await ctx.ui.confirm(
      "This will uninstall all @pi-stef packages and delete your catalog config. Continue?",
    );
    if (!confirmed) {
      ctx.ui.notify("Reset cancelled", "info");
      return;
    }
  }

  // --- Read catalog and find @pi-stef packages (NOT catalog) -------------------
  const catalog = readCatalog(ctx.home);
  // isPiStefSource returns false for @pi-stef/catalog by design (see packages.ts)
  const piStefNames = Object.keys(catalog.packages).filter(
    (name) => isPiStefSource(catalog.packages[name].source),
  );

  // --- Uninstall @pi-stef packages -------------------------------------------
  let uninstalled = 0;
  for (const name of piStefNames) {
    const source = catalog.packages[name].source;
    try {
      await piUninstall(source);
      uninstalled++;
    } catch {
      ctx.ui.notify(
        `Warning: uninstall of "${name}" failed — continuing with reset`,
        "warning",
      );
    }
  }

  // --- Delete config files ---------------------------------------------------
  const lockPath = lockFile(ctx.home);
  const dirPath = catalogDir(ctx.home);
  const gistPath = `${dirPath}/.gist`;

  for (const filePath of [catPath, lockPath, gistPath]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort deletion
    }
  }

  // Remove empty catalog directory
  try {
    if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // Best-effort cleanup
  }

  ctx.ui.notify(
    `Reset complete: uninstalled ${uninstalled} @pi-stef packages, deleted config files`,
    "info",
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test -- tests/commands/reset.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/src/commands/reset.ts packages/catalog/tests/commands/reset.test.ts
git commit -m "feat(ct): add ct reset command

Full nuke: uninstalls all @pi-stef packages (except catalog),
deletes gist cache, deletes cat.yaml and lock file.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4.2: Wire reset into register.ts

**Files:**
- Modify: `packages/catalog/src/register.ts`

- [ ] **Step 1: Add import and switch case**

In `register.ts`, add the import:

```ts
import { resetCommand, type ResetCtx } from "./commands/reset.js";
```

Add a case in the `handleSubcommand` switch (after the `update` case):

```ts
    case "reset":
      await resetCommand(parsed, ctx);
      break;
```

Add the `ct_reset` LLM tool registration after the `ct_update` tool block:

```ts
  pi.registerTool({
    name: "ct_reset",
    label: "Catalog Reset",
    description:
      "Reset the catalog: uninstall all @pi-stef packages (except catalog) and delete all config files (cat.yaml, lock file, gist cache).",
    promptSnippet: "Reset catalog to clean state",
    promptGuidelines: [
      "Use ct_reset when the user asks to reset, nuke, or clean their catalog completely.",
    ],
    parameters: Type.Object({
      yes: Type.Optional(Type.Boolean({ description: "Skip confirmation prompt" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = {
          positional: [],
          flags: params.yes ? { yes: true } : {},
        };
        await resetCommand(args, ctx as unknown as ResetCtx);
        return { content: [{ type: "text" as const, text: "Reset completed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Reset failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
```

- [ ] **Step 2: Run typecheck and all tests**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog typecheck && pnpm --filter @pi-stef/catalog test`
Expected: No errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/catalog/src/register.ts
git commit -m "feat(ct): wire ct reset command and LLM tool

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 5: Final verification

### Task 5.1: Run full test suite and typecheck

- [ ] **Step 1: Run typecheck**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog typecheck`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog test`
Expected: All tests pass

- [ ] **Step 3: Run lint (if configured)**

Run: `cd /Users/stefano/Projects/pi-stef && pnpm --filter @pi-stef/catalog lint`
Expected: No errors

- [ ] **Step 4: Final commit with all fixes if needed**

```bash
git add -A
git commit -m "chore(ct): final fixes from milestone 5 verification

Co-Authored-By: Claude <noreply@anthropic.com>"
```
