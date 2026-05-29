# pi-stef

Custom package collection for the [pi](https://pi.dev) coding agent.

## Packages

| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter` |
| [sf-team](packages/sf-team/README.md) | extension | Steerable team of role-agents for plan/review/implement workflows | `pi install git:github.com/<USER>/pi-stef#packages/sf-team` |
| [agent-workflows](packages/agent-workflows/README.md) | library | Reusable workflow engine primitives | `pi install git:github.com/<USER>/pi-stef#packages/agent-workflows` |
| [atlassian](packages/atlassian/README.md) | extension | Jira and Confluence integration tools | `pi install git:github.com/<USER>/pi-stef#packages/atlassian` |
| [figma](packages/figma/README.md) | extension | Figma REST API tools and design context | `pi install git:github.com/<USER>/pi-stef#packages/figma` |
| [web](packages/web/README.md) | extension | Web search, URL fetch, and browser sessions | `pi install git:github.com/<USER>/pi-stef#packages/web` |

## Install All

```bash
./scripts/install-all.sh
```

For project-local install:

```bash
./scripts/install-all.sh --project
```

## Individual Install

```bash
pi install git:github.com/<USER>/pi-stef#packages/<package-name>
```

## Package Management

Use [pi-depo](https://github.com/fulgidus/pi-depo) for declarative package management and cross-machine sync. Add packages to your `kit.yml`:

```yaml
packages:
  superpowers-adapter:
    source: "git:github.com/<USER>/pi-stef#packages/superpowers-adapter"
    rating: core
  sf-team:
    source: "git:github.com/<USER>/pi-stef#packages/sf-team"
    rating: core
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
