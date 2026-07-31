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
│   ├── cursor/            # Cursor AI editor as a native Pi stream provider (@cursor/sdk)
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

## Cursor Model Scraping

The Cursor SDK API omits context-window info for most ("silent") models. The `@pi-stef/cursor` package fills this gap by scraping `cursor.com/docs/models/<slug>` for the real **Context window** and **Max context** values, persisted to `packages/cursor/src/model-scraped-contexts.generated.ts` and used as a fallback so silent models report their actual window instead of the 200 K default.

**Precedence (highest wins):**
1. API context (live from `Cursor.models.list`)
2. `KNOWN_CONTEXT_WINDOWS` (curated table)
3. Scraped contexts (this file)
4. 200 K default

### Manual Scrape

No API key is needed. One-time setup + regeneration:

```bash
# install a chromium browser for playwright-core
npx playwright install chromium

# regenerate the scraped-contexts file
pnpm --filter @pi-stef/cursor tsx scripts/scrape-docs-contexts.ts
```

This writes `packages/cursor/src/model-scraped-contexts.generated.ts`. Commit the file and release (`pnpm release`).

To use your system Chrome instead of the bundled Chromium, set `PI_CURSOR_SCRAPE_CHANNEL=chrome`.

> **Note:** The full refresh command (`CURSOR_API_KEY=… pnpm --filter @pi-stef/cursor refresh-models`) also scrapes *and* refreshes the live model list (`model-fallback.generated.ts`). It requires an API key; the scrape-only CLI above does not.

### Automated (CI)

`.github/workflows/cursor-scrape-release.yml` runs weekly (once enabled) via a Monday 06:00 UTC cron. If the scraped result differs from the committed file, it commits the change and cuts a **patch release** of `@pi-stef/cursor` (the tag push triggers `publish.yml` → npm).

**Requirements:**
- A `CURSOR_RELEASE_TOKEN` PAT secret with `repo` + `workflow` scopes (the default `GITHUB_TOKEN` cannot trigger the downstream publish workflow).
- "Read and write" workflow permissions in the repo's Actions settings.

You can trigger a manual run at any time via `workflow_dispatch` from the Actions tab.

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
