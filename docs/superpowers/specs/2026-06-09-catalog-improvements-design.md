# Catalog Package Improvements

**Date**: 2026-06-09
**Status**: Approved
**Approach**: Incremental Extension (Approach A)

## Overview

Five improvements to the `@pi-stef/catalog` package:

1. Auto-derive package name from source (remove manual `name` parameter)
2. Add `ct update` command for updating packages
3. Add `--scope` flag for batch add/remove of `@pi-stef` packages
4. Add `ct reset` command for full cleanup
5. Catalog package auto-skipped in batch operations

## Requirement 1: Auto-derive name from source

**Current**: `ct add <name> <source>` — user provides both name and source.
**New**: `ct add <source>` — name derived via `sourceToKey()` from `source.ts`.

### sourceToKey() mapping (existing)

- `npm:@pi-stef/catalog` → `@pi-stef/catalog`
- `git:github.com/sfiorini/pi-stef#packages/catalog` → `sfiorini/pi-stef`
- `/Users/foo/bar` → `/Users/foo/bar`

### Changes

| File | Change |
|------|--------|
| `commands/add.ts` | Remove `name` from positional args. Call `sourceToKey(source)` to derive key. Pass derived name to `addPackage()`. |
| `catalog/crud.ts` | No signature change — callers now pass derived name. |
| `register.ts` | Update `ct_add` LLM tool schema: remove `name` parameter, keep `source` + optional `rating`, `type`. |

### Backward compatibility

If someone passes two positional args (old syntax `ct add myname npm:foo`), detect it: first arg doesn't look like a source (doesn't start with `npm:`, `git:`, `/`, `./`), so treat as legacy name and warn. The second arg is the source. This ensures existing workflows don't break silently.

## Requirement 2: `ct update` command

**Subcommand**: `ct update [package] [--all]` (alias: `up`)

### Behavior

- `ct update <name>` — updates one package. Looks up source from `cat.yaml`, runs `pi update <source>`, updates lock file.
- `ct update --all` — iterates all enabled packages, runs `pi update <source>` for each, updates lock file.
- `ct update` with no args and no `--all` — shows usage/help.

### Changes

| File | Change |
|------|--------|
| `commands/update.ts` | New file. Handler reads cat.yaml, resolves packages, calls `execCommand('pi', ['update', source])` per package, updates lock file. |
| `commands/definitions.ts` | Add `update` entry to `SUBCOMMAND_DEFS` with alias `up`. |
| `register.ts` | New `ct_update` LLM tool with schema: `{ name?: string, all?: boolean }`. |

### Lock file update

After successful `pi update`, read installed version from `settings.json` via `scanInstalled()` and write to lock file.

### Error handling

- Package not in catalog → error with suggestion to `ct add` first.
- `pi update` fails → log error, continue to next package.
- `--all` with no packages → "No packages to update."

## Requirement 3: Scope-based batch operations

**New flag**: `--scope <scope>` on `ct add` and `ct remove`.

### Behavior

- `ct add --scope @pi-stef` — adds all `@pi-stef/*` packages from hardcoded list, installs each. Excludes catalog.
- `ct remove --scope @pi-stef` — removes all installed `@pi-stef/*` packages from catalog, uninstalls each. Excludes catalog.

### Package discovery

Hardcoded list in `src/catalog/pi-stef-packages.ts`:

```typescript
export const PI_STEF_PACKAGES = [
  '@pi-stef/agent-workflows',
  '@pi-stef/atlassian',
  '@pi-stef/figma',
  '@pi-stef/paths',
  '@pi-stef/team',
  '@pi-stef/web',
  // @pi-stef/catalog intentionally excluded
];
```

### Changes

| File | Change |
|------|--------|
| `catalog/pi-stef-packages.ts` | New file. Hardcoded list of `@pi-stef/*` packages (excluding catalog). |
| `commands/add.ts` | When `--scope` set, iterate `PI_STEF_PACKAGES`, call `addPackage()` + `piInstall()` for each. Skip if already in catalog. |
| `commands/remove.ts` | When `--scope` set, scan catalog for matching source prefix, call `removePackage()` + `piUninstall()` for each. Skip catalog. |
| `commands/dispatch.ts` | No change — already parses `--key=value` flags. |

### Catalog guard (Req 5)

Both add and remove check if package is `@pi-stef/catalog` and skip silently.

## Requirement 4: `ct reset` command

**Subcommand**: `ct reset [--yes]`

### Behavior (full nuke)

1. Scan `cat.yaml` for all `@pi-stef/*` packages (excluding catalog).
2. Run `pi uninstall <source>` for each.
3. Delete GitHub Gist remote (if gist ID cached in `.gist`). Best-effort.
4. Delete local config files: `cat.yaml`, `catalog.lock.json`, `.gist`.

### Changes

| File | Change |
|------|--------|
| `commands/reset.ts` | New file. Handler implements 4-step nuke sequence. |
| `commands/definitions.ts` | Add `reset` entry to `SUBCOMMAND_DEFS`. |
| `register.ts` | New `ct_reset` LLM tool with schema: `{ yes?: boolean }`. |

### Safety

- `--yes` flag skips confirmation. Without it: "This will uninstall all @pi-stef packages and delete your catalog config. Continue? (y/N)"
- Gist deletion is best-effort — warn on failure, don't abort.
- If `cat.yaml` doesn't exist, skip gracefully.

## Summary of all file changes

| File | Action |
|------|--------|
| `commands/add.ts` | Modify: remove name param, add --scope support |
| `commands/remove.ts` | Modify: add --scope support |
| `commands/update.ts` | **New**: update command handler |
| `commands/reset.ts` | **New**: reset command handler |
| `commands/definitions.ts` | Modify: add update, reset to SUBCOMMAND_DEFS |
| `register.ts` | Modify: update ct_add schema, add ct_update + ct_reset tools |
| `catalog/pi-stef-packages.ts` | **New**: hardcoded @pi-stef package list |
| `catalog/crud.ts` | No change |
| `catalog/source.ts` | No change |
