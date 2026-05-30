# @pi-stef/catalog

Declarative package manager for the [pi](https://pi.dev) coding agent. Manage your skills and extensions from a single `cat.yaml` file, sync across machines via GitHub Gist.

## Installation

```bash
pi install git:github.com/sfiorini/pi-stef#packages/catalog
```

## Quick Start

```bash
# 1. Authenticate with GitHub (requires gh CLI)
/ct login

# 2. Initialize catalog from installed packages (or import from a gist)
/ct init
#   or: /ct init --from-gist=<gist-id>

# 3. Sync — install missing, remove orphaned, push changes to gist
/ct sync
```

After `ct login`, your GitHub token is cached for future sync operations.

## Command Reference

All commands are invoked as `/ct <subcommand>` inside pi, or via the shorthand `/ct-<subcommand>`.

| Subcommand | Alias | Description | Flags |
|---|---|---|---|
| `sync` | — | Full sync cycle: pull → reconcile → execute → push | `--dry-run`, `--force`, `--no-push`, `--profile=<name>` |
| `init` | — | Initialize catalog from installed packages or a gist | `--from-gist=<id>` |
| `add` | `a` | Add a package to the catalog and install it | `--rating=<r>`, `-r <r>`, `--type=<t>`, `-s <t>` |
| `remove` | `rm` | Remove a package from the catalog | — |
| `toggle` | — | Cycle a package's rating: core → useful → debatable → disabled → core | — |
| `enable` | — | Re-enable a disabled package (restores previous rating) | — |
| `disable` | — | Disable a package (preserves rating for later restore) | — |
| `push` | — | Push local catalog + lock to GitHub Gist | `--dry-run`, `--profile=<name>` |
| `pull` | — | Pull remote catalog from gist and reconcile | `--dry-run`, `--profile=<name>` |
| `login` | — | Authenticate with GitHub via `gh` CLI | — |
| `status` | — | Show catalog status, package counts, gist URL, last sync | — |
| `diff` | — | Show diff between local and remote catalog | — |
| `verify` | — | Verify catalog integrity (sources, ratings, duplicates) | — |
| `profiles` | — | List all profiles with active indicator | — |
| `profile` | — | Show or switch active profile | — |

### Adding Packages

```bash
# Add from a git source (prompts for type if not specified)
/ct add my-skill git:github.com/user/repo#packages/my-skill

# Add with explicit rating and type
/ct add my-skill git:github.com/user/repo#packages/my-skill --rating=useful --type=skill

# Add an npm package
/ct add lodash npm:lodash
```

### Removing Packages

```bash
/ct remove my-skill
```

## `cat.yaml` Format

The catalog is stored in `cat.yaml`. Example:

```yaml
meta:
  pi_version: "0.70.0"
  activeProfile: default

packages:
  superpowers-adapter:
    source: "git:github.com/sfiorini/pi-stef#packages/superpowers-adapter"
    rating: core
    type: skill
  team:
    source: "git:github.com/sfiorini/pi-stef#packages/team"
    rating: core
    type: skill
  atlassian:
    source: "git:github.com/sfiorini/pi-stef#packages/atlassian"
    rating: useful
    type: skill
    enabled: false
    previousRating: useful
```

### Package Fields

| Field | Required | Description |
|---|---|---|
| `source` | ✓ | Package source URL (`npm:…` or `git:…`) |
| `rating` | ✓ | One of: `core`, `useful`, `debatable`, `disabled` |
| `type` | — | `skill` or `pi-native` |
| `profile` | — | Profile name this package belongs to |
| `enabled` | — | `true` (default) or `false` |
| `previousRating` | — | Rating before disable; restored by `ct enable` |

### Examples

**NPM source:**
```yaml
packages:
  lodash:
    source: "npm:lodash"
    rating: useful
```

**Git source:**
```yaml
packages:
  my-extension:
    source: "git:github.com/user/repo#packages/my-extension"
    rating: core
    type: pi-native
```

**Git source with subpath:**
```yaml
packages:
  my-skill:
    source: "git:github.com/user/repo#skills/my-skill"
    rating: core
    type: skill
```

## Profiles

Profiles let you maintain different package sets for different machines or contexts (e.g., work vs. personal).

```yaml
meta:
  pi_version: "0.70.0"
  activeProfile: work

packages:
  superpowers-adapter:
    source: "git:github.com/sfiorini/pi-stef#packages/superpowers-adapter"
    rating: core

profiles:
  work:
    packages:
      atlassian:
        source: "git:github.com/sfiorini/pi-stef#packages/atlassian"
        rating: core
  personal:
    packages:
      figma:
        source: "git:github.com/sfiorini/pi-stef#packages/figma"
        rating: useful
```

**Profile commands:**
- `/ct profiles` — list all profiles (shows active with a marker)
- `/ct profile <name>` — switch active profile
- `--profile=<name>` flag on `sync`, `push`, `pull` — operate on a specific profile

The `default` profile always exists and uses the base `packages` section. Profile packages override base packages with the same key.

## Configuration

### File Locations

| File | Path | Purpose |
|---|---|---|
| Catalog | `~/.pi/sf/catalog/cat.yaml` | Declarative package manifest |
| Lock file | `~/.pi/sf/catalog/catalog.lock.json` | Installed versions and hashes |
| Gist cache | `~/.pi/sf/catalog/` | Cached gist ID for sync |

### GitHub Gist Setup

Sync uses GitHub Gists for cloud storage. Prerequisites:

1. Install the [GitHub CLI (`gh`)](https://cli.github.com/)
2. Authenticate: `gh auth login`
3. Run `/ct login` inside pi to verify and cache your token

On first `ct push` or `ct sync`, a secret gist is created automatically.

## Migration from pi-depo / kit.yml

If you previously used `pi-depo` with a `kit.yml` file:

1. Rename `kit.yml` to `cat.yaml`
2. Move it to `~/.pi/sf/catalog/cat.yaml`
3. Update the format:
   - Replace `rating` string values with catalog rating enum (`core` | `useful` | `debatable`)
   - Add `meta.pi_version` field
4. Run `/ct login` to set up gist sync
5. Run `/ct sync` to push and reconcile

## Development

```bash
pnpm install          # Install dependencies
pnpm -F @pi-stef/catalog test    # Run tests
pnpm -F @pi-stef/catalog typecheck  # Type check
```

## License

MIT
