# @pi-stef/catalog

Declarative package manager for the [pi](https://pi.dev) coding agent. Manage your skills and extensions from a single `cat.yaml` file, sync across machines via GitHub Gist.

## Installation

```bash
pi install npm:@pi-stef/catalog
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
| `add` | `a` | Add a package to the catalog and install it | `--type=<t>`, `-s <t>`, `--scope=@pi-stef` |
| `remove` | `rm` | Remove a package from the catalog | `--yes`, `--scope=@pi-stef` |
| `toggle` | — | Toggle a package's enabled state (enabled ↔ disabled) | — |
| `enable` | — | Enable a disabled package | — |
| `disable` | — | Disable a package and uninstall it | — |
| `update` | `up` | Update packages to latest versions | `--all` |
| `push` | — | Push local catalog + lock to GitHub Gist | `--dry-run`, `--profile=<name>` |
| `pull` | — | Pull remote catalog from gist and reconcile | `--dry-run`, `--profile=<name>` |
| `login` | — | Authenticate with GitHub via `gh` CLI | — |
| `status` | — | Show catalog status with package listing | — |
| `diff` | — | Show diff between local and remote catalog | — |
| `verify` | — | Verify catalog integrity | — |
| `profiles` | — | List all profiles with active indicator | — |
| `profile` | — | Show or switch active profile | — |
| `reset` | — | Uninstall all @pi-stef packages and delete config | `--yes` |

### Adding Packages

```bash
# Add from a git source (name auto-derived)
/ct add git:github.com/user/repo#packages/my-skill

# Add an npm package
/ct add npm:lodash

# Add all @pi-stef packages at once
/ct add --scope=@pi-stef
```

### Removing Packages

```bash
/ct remove my-skill
/ct remove --scope=@pi-stef
```

### Enabling and Disabling

```bash
/ct enable my-skill      # Enable a disabled package
/ct disable my-skill     # Disable a package (uninstalls it)
/ct toggle my-skill      # Toggle enabled ↔ disabled
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
    type: skill
  team:
    source: "git:github.com/sfiorini/pi-stef#packages/team"
    type: skill
  atlassian:
    source: "git:github.com/sfiorini/pi-stef#packages/atlassian"
    type: skill
    enabled: false
```

### Package Fields

| Field | Required | Description |
|---|---|---|
| `source` | ✓ | Package source URL (`npm:…` or `git:…`) |
| `type` | — | `skill` or `pi-native` |
| `profile` | — | Profile name this package belongs to |
| `enabled` | — | `true` (default) or `false` |

### Examples

**NPM source:**
```yaml
packages:
  lodash:
    source: "npm:lodash"
```

**Git source:**
```yaml
packages:
  my-extension:
    source: "git:github.com/user/repo#packages/my-extension"
    type: pi-native
```

## Setup Detection

Packages can include a `.pi-setup.json` file declaring requirements (environment variables, config files, CLI tools). After install or update, the catalog checks these requirements and warns if anything is missing.

```json
{
  "env": ["API_TOKEN"],
  "files": ["config.json"],
  "cli": ["docker"]
}
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

profiles:
  work:
    packages:
      atlassian:
        source: "git:github.com/sfiorini/pi-stef#packages/atlassian"
  personal:
    packages:
      figma:
        source: "git:github.com/sfiorini/pi-stef#packages/figma"
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

## Development

```bash
pnpm install          # Install dependencies
pnpm -F @pi-stef/catalog test    # Run tests
pnpm -F @pi-stef/catalog typecheck  # Type check
```

## License

MIT
