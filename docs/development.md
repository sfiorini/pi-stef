# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [pi](https://pi.dev) >= 0.70 (for testing extensions locally)
- [GitHub CLI](https://cli.github.com/) (`gh`) (for catalog sync and gist operations)

## Repository Structure

```
pi-stef/
├── packages/
│   ├── catalog/           # Declarative package manager extension
│   ├── pair/                  # Plan/review/implement workflows using pi-subagents
│   ├── team/              # Team of role-agents for plan/review/implement
│   ├── agent-workflows/   # Workflow engine primitives (internal)
│   ├── atlassian/         # Jira and Confluence integration
│   ├── figma/             # Figma REST API tools
│   ├── paths/             # Shared path conventions
│   └── web/               # Web search, URL fetch, browser automation
├── scripts/
│   ├── release.mjs        # Interactive release script
│   └── lib.mjs            # Shared release helpers
├── docs-site/             # VitePress documentation site
└── docs/
    └── development.md     # This file
```

This is a **pnpm workspace monorepo**. Each package under `packages/` is independently versioned and published to npm under the `@pi-stef` scope.

## Getting Started

```bash
# Clone the repository
git clone git@github.com:sfiorini/pi-stef.git
cd pi-stef

# Install dependencies
pnpm install

# Run tests across all packages
pnpm test

# Type check all packages
pnpm typecheck
```

## Testing

Tests use [Vitest](https://vitest.dev/). Run them from the repository root:

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests for a specific package
pnpm test -- --reporter=verbose packages/catalog
```

## Type Checking

TypeScript is configured with project references. Type check from the root:

```bash
pnpm typecheck
```

This runs `tsc -b` which builds all packages in dependency order and reports type errors.

## Release Process

Releases are done locally via the interactive release script:

```bash
pnpm release
```

This script:
1. Discovers all packages in `packages/`
2. Prompts you to select a package (or "all")
3. Prompts for bump type (patch/minor/major)
4. Updates `package.json` versions and cross-package dependencies
5. Updates `CHANGELOG.md` with commit messages since last release
6. Commits, tags (`@pi-stef/<package>@<version>`), and pushes
7. The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers on tag push and publishes to npm

Dry-run mode is available:

```bash
pnpm release -- --dry-run
```

## Documentation Site

The documentation site is built with [VitePress](https://vitepress.dev/) and deployed to GitHub Pages.

```bash
# Preview locally
pnpm docs:preview

# Build for production
pnpm docs:build
```

The site is automatically built and deployed when you run `pnpm release`.

## Contributing

1. Create a feature branch from `main`
2. Make changes with tests (TDD preferred)
3. Run `pnpm test` and `pnpm typecheck`
4. Commit with conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`)
5. Push and open a PR
