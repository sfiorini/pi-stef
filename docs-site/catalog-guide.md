# Catalog Guide

The catalog (`ct`) is a declarative package manager for pi. It manages packages via a `cat.yaml` file and syncs across machines using GitHub Gist.

## Installation

```bash
pi install npm:@pi-stef/catalog
```

## Quick Start

```bash
/ct login          # Authenticate with GitHub
/ct init           # Create cat.yaml
/ct add npm:@pi-stef/flow   # Add a package
/ct sync           # Install + push to gist
```

## Commands

| Command | Description |
|---------|-------------|
| `/ct sync` | Pull, reconcile, install, push |
| `/ct init` | Initialize cat.yaml |
| `/ct init --from-gist=<id>` | Import catalog from a gist |
| `/ct add <source>` | Add a package (name auto-derived) |
| `/ct remove <name>` | Remove a package |
| `/ct update <name>` | Update a package to latest |
| `/ct update --all` | Update all packages |
| `/ct enable <name>` | Enable a package |
| `/ct disable <name>` | Disable a package |
| `/ct toggle <name>` | Toggle enabled/disabled |
| `/ct status` | Show catalog status |
| `/ct diff` | Show pending changes |
| `/ct verify` | Verify catalog integrity |
| `/ct push` | Push catalog to gist |
| `/ct pull` | Pull catalog from gist |
| `/ct login` | Authenticate with GitHub |
| `/ct profiles` | List all profiles |
| `/ct profile <name>` | Show/switch active profile |
| `/ct profile <name> --create` | Create a new profile |
| `/ct profile <name> --delete` | Delete a profile |
| `/ct reset` | Reset catalog and lock file |

## cat.yaml Format

The catalog file (`~/.pi/sf/catalog/cat.yaml`) declares your packages:

```yaml
meta:
  activeProfile: default

packages:
  azure-foundry:
    source: npm:@pi-stef/azure-foundry
    enabled: true
  cursor:
    source: npm:@pi-stef/cursor
    enabled: true
  team:
    source: npm:@pi-stef/flow
    enabled: true
  web:
    source: npm:@pi-stef/web
    enabled: true
  figma:
    source: npm:@pi-stef/figma
    enabled: false
```

### Package Fields

| Field | Required | Description |
|-------|----------|-------------|
| `source` | Yes | Package source (e.g., `npm:@pi-stef/flow`, `git:github.com/user/repo`) |
| `type` | No | `"skill"` or `"pi-native"` |
| `enabled` | No | `true` (default) or `false` |
| `profile` | No | Label for the package (annotation only) |

## Setup Detection

Some packages require additional setup (environment variables, CLI tools, config files). The catalog detects these requirements via `.pi-setup.json` files and warns you during install/update.

For example, the atlassian package needs:

```json
{
  "env": ["ATLASSIAN_BASE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"]
}
```

If these are missing, `/ct status` shows a `⚠ setup incomplete` warning.

## Lock File

The catalog maintains a `catalog.lock.json` that tracks installed versions and sync state. This file is managed automatically — do not edit it manually.

## Configuration Files

| File | Location |
|------|----------|
| Catalog manifest | `~/.pi/sf/catalog/cat.yaml` |
| Lock file | `~/.pi/sf/catalog/catalog.lock.json` |
| Gist cache | `~/.pi/sf/catalog/.gist` |
| Package config | `~/.pi/sf/<package>/config.json` |
