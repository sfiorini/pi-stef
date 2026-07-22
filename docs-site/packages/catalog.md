# catalog

Declarative package manager for the [pi](https://pi.dev) coding agent. Manage your skills and extensions from a single `cat.yaml` file, sync across machines via GitHub Gist.

## Installation

```bash
pi install npm:@pi-stef/catalog
```

## Quick Start

```bash
/ct login          # Authenticate with GitHub (requires gh CLI)
/ct init           # Initialize catalog from installed packages
/ct add npm:@pi-stef/flow   # Add a package
/ct sync           # Install + push to gist
```

## Hot-Reload

Commands that install, update, or remove packages (`add`, `update`, `remove`, `disable`, `sync`, `pull`) automatically reload extensions after a successful operation. New or updated tools are available immediately without restarting pi.

If the reload fails or is not available (e.g., when invoked via an LLM tool), you'll see a message asking you to restart pi for changes to take effect.

## Command Reference

| Subcommand | Description | Flags |
|---|---|---|
| `sync` | Full sync cycle: pull → reconcile → execute → push | `--dry-run`, `--force`, `--no-push`, `--profile=<name>` |
| `init` | Initialize catalog from installed packages or a gist | `--from-gist=<id>` |
| `add` | Add a package to the catalog and install it | `--type=<t>`, `--scope=@pi-stef` |
| `remove` | Remove a package from the catalog | `--yes`, `--scope=@pi-stef` |
| `toggle` | Toggle a package's enabled state | — |
| `enable` | Enable a disabled package | — |
| `disable` | Disable a package and uninstall it | — |
| `update` | Update packages to latest versions | `--all` |
| `push` | Push local catalog + lock to GitHub Gist | `--dry-run`, `--profile=<name>` |
| `pull` | Pull remote catalog from gist and reconcile | `--dry-run`, `--profile=<name>` |
| `login` | Authenticate with GitHub via `gh` CLI | — |
| `status` | Show catalog status with package listing | — |
| `diff` | Show diff between local and remote catalog | — |
| `verify` | Verify catalog integrity | — |
| `profiles` | List all profiles with active indicator | — |
| `profile` | Show or switch active profile | — |
| `reset` | Uninstall all @pi-stef packages and delete config | `--yes` |

## cat.yaml Format

```yaml
meta:
  pi_version: "0.70.0"
  activeProfile: default

packages:
  flow:
    source: "npm:@pi-stef/flow"
    type: skill
  cursor:
    source: "npm:@pi-stef/cursor"
    type: skill
  atlassian:
    source: "npm:@pi-stef/atlassian"
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
| `companions` | — | Array of companion source strings to auto-install |

### Companions

A package can declare required companion packages in its own `package.json`:

```json
{
  "pi": {
    "companions": ["git:github.com/obra/superpowers"]
  }
}
```

When `ct add` installs such a package, it also installs each companion that
isn't already installed. Companions resolve transitively (a companion may
declare its own companions) up to a depth of 3, with de-duplication so each
source installs at most once.

## Setup Detection

Packages can include a `.pi-setup.json` file declaring requirements (environment variables, config files, CLI tools). After install or update, the catalog checks these requirements and warns if anything is missing.

## Profiles

Profiles let you maintain different package sets for different machines or contexts. See [Profiles & Sharing](/profiles) for details.

## Configuration

| File | Path | Purpose |
|---|---|---|
| Catalog | `~/.pi/sf/catalog/cat.yaml` | Declarative package manifest |
| Lock file | `~/.pi/sf/catalog/catalog.lock.json` | Installed versions and hashes |
| Gist cache | `~/.pi/sf/catalog/` | Cached gist ID for sync |

## Development

```bash
pnpm install
pnpm -F @pi-stef/catalog test
pnpm -F @pi-stef/catalog typecheck
```
