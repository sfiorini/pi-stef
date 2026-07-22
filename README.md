# pi-stef

Custom package collection for the [pi](https://pi.dev) coding agent.

> 📖 **[Full Documentation](https://sfiorini.github.io/pi-stef/)** | [Development Guide](docs/development.md)

## Quick Start

```bash
# 1. Install the catalog manager first
pi install npm:@pi-stef/catalog

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
| **[catalog](packages/catalog/README.md)** | extension | Declarative package manager — sync, add, remove, toggle packages via `cat.yaml` | `pi install npm:@pi-stef/catalog` |
| [azure-foundry](packages/azure-foundry/README.md) | extension | Azure Foundry and Azure OpenAI deployments as native Pi providers | `pi install npm:@pi-stef/azure-foundry` |
| [cursor](packages/cursor/README.md) | extension | Cursor AI editor as a native Pi stream provider | `pi install npm:@pi-stef/cursor` |
| [flow](https://sfiorini.github.io/pi-stef/packages/flow) | extension | Reusable multi-agent workflows + CodeRabbit-style audit | `pi install npm:@pi-stef/flow` |
| [pair](https://sfiorini.github.io/pi-stef/packages/pair) | extension | **[DEPRECATED → flow]** Plan/review/implement workflows using pi-subagents | `pi install npm:@pi-stef/pair` |
| [team](packages/team/README.md) | extension | **[DEPRECATED → flow]** Steerable team of role-agents for plan/review/implement workflows | `pi install npm:@pi-stef/team` |
| [agent-workflows](packages/agent-workflows/README.md) | library | Reusable workflow engine primitives (internal dependency, not user-installed) | — |
| paths | library | Shared path conventions for all sf packages | — |
| [atlassian](packages/atlassian/README.md) | extension | Jira and Confluence integration tools | `pi install npm:@pi-stef/atlassian` |
| [figma](packages/figma/README.md) | extension | Figma REST API tools and design context | `pi install npm:@pi-stef/figma` |
| [web](packages/web/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install npm:@pi-stef/web` |
| [finance](packages/finance/README.md) | extension | Portfolio tracking, drift analysis, and investment suggestions | `pi install npm:@pi-stef/finance` |
| [finance-api](packages/finance-api/README.md) | service | Always-on local service for financial data ingestion and quant engine | Docker/native (see README) |

## Package Management

Use the [catalog](packages/catalog/README.md) extension (`ct`) for declarative package management and cross-machine sync.

```bash
/ct add <source>              # Add a package (name auto-derived)
/ct remove <name>             # Remove a package
/ct enable <name>             # Enable a package
/ct disable <name>            # Disable a package
/ct sync                      # Sync with remote gist
/ct status                    # Show catalog status
```

See the [catalog README](packages/catalog/README.md) for the full command reference, `cat.yaml` format, and profile documentation.

## Install All

Use `ct sync` to install all catalog packages:

```bash
/ct sync
```

## Profiles & Sharing

### Pull your catalog from a gist

If you've already set up catalog sync (`/ct login` + `/ct sync`), your packages sync automatically via GitHub Gist. Use profiles to maintain different package sets for different machines:

```bash
/ct profile work --create    # Create a "work" profile
/ct profile work             # Switch to it
/ct add npm:@pi-stef/atlassian  # Add work-specific packages
/ct sync --profile work      # Sync this profile to its own gist
```

### Import someone else's catalog

To start from another person's catalog (e.g., a shared team setup):

```bash
/ct init --from-gist=<gist-id>
```

This replaces your entire local catalog with the contents of that gist, including any profiles it defines. After importing, run `/ct sync` to install all packages.

**How to find a gist ID:** The gist URL is `https://gist.github.com/<user>/<gist-id>`. The `<gist-id>` is the last part of the URL.

### Limitations

- `/ct init --from-gist` replaces your entire catalog — it does not merge or selectively import.
- There is no command to import a single profile from another user's gist. You can manually copy profile entries from their `cat.yaml` into yours.
- Each profile syncs to its own gist (described as `catalog-<profile-name>`). The gist cache stores only one ID at a time.

## Individual Install

```bash
pi install npm:@pi-stef/<package-name>
```

## Prerequisites

- [pi](https://pi.dev) (>= 0.70)
- Node.js (>= 20)
- pnpm (>= 9)
- [GitHub CLI](https://cli.github.com/) (`gh`) — required for `/ct login` and catalog sync

## Development

See the [Development Guide](docs/development.md) for prerequisites, repository structure, testing, and release process.

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests
pnpm typecheck        # Type check
```

## License

[MIT](LICENSE)
