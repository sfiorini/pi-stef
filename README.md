# pi-stef

Custom package collection for the [pi](https://pi.dev) coding agent.

## Packages

| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [superpowers-adapter](packages/superpowers-adapter/README.md) | extension | Bridges superpowers skill system to pi | `pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter` |

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
