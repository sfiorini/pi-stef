# pi-stef

Custom package collection for the [pi](https://pi.dev) coding agent.

## Quick Start

```bash
# 1. Install the catalog manager first
pi install git:github.com/sfiorini/pi-stef#packages/catalog

# 2. Authenticate with GitHub
/ct login

# 3. Initialize your catalog from installed packages
/ct init

# 4. Sync — keeps your packages up to date across machines
/ct sync
```

## Packages

| Package | Type | Description | Install |
|---------|------|-------------|---------|
| **[catalog](packages/catalog/README.md)** | extension | Declarative package manager — sync, add, remove, toggle packages via `cat.yaml` | `pi install git:github.com/sfiorini/pi-stef#packages/catalog` |
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/sfiorini/pi-stef#packages/superpowers-adapter` |
| [team](packages/team/README.md) | extension | Steerable team of role-agents for plan/review/implement workflows | `pi install git:github.com/sfiorini/pi-stef#packages/team` |
| [agent-workflows](packages/agent-workflows/README.md) | library | Reusable workflow engine primitives | `pi install git:github.com/sfiorini/pi-stef#packages/agent-workflows` |
| [atlassian](packages/atlassian/README.md) | extension | Jira and Confluence integration tools | `pi install git:github.com/sfiorini/pi-stef#packages/atlassian` |
| [figma](packages/figma/README.md) | extension | Figma REST API tools and design context | `pi install git:github.com/sfiorini/pi-stef#packages/figma` |
| [web](packages/web/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install git:github.com/sfiorini/pi-stef#packages/web` |

## Package Management

Use the [catalog](packages/catalog/README.md) extension (`ct`) for declarative package management and cross-machine sync.

```bash
/ct add <name> <source>       # Add a package
/ct remove <name>             # Remove a package
/ct sync                      # Sync with remote gist
/ct status                    # Show catalog status
```

See the [catalog README](packages/catalog/README.md) for the full command reference, `cat.yaml` format, and profile documentation.

## Install All

Use `ct sync` to install all catalog packages:

```bash
/ct sync
```

The legacy `scripts/install-all.sh` script is deprecated. See [migration notes](packages/catalog/README.md#migration-from-pi-depo--kityml).

## Individual Install

```bash
pi install git:github.com/sfiorini/pi-stef#packages/<package-name>
```

## Prerequisites

- [pi](https://pi.dev) (>= 0.70)
- Node.js (>= 20)
- pnpm (>= 9)

## Development

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests
pnpm typecheck        # Type check
```

## License

MIT
