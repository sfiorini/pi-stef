# @pi-stef/atlassian

Pi extension and development CLI for Atlassian Jira and Confluence Cloud tools.

This package is implemented against the current Atlassian Cloud REST APIs:

- Confluence REST v2 for page, space, comment, and label reads/writes where v2 covers the operation.
- Jira platform REST v3 for project, issue, search, comment, worklog, link, version, field, user, and attachment operations.
- Jira Software REST for Agile board, sprint, backlog, ranking, and epic operations.

## Installation

```bash
pi install npm:@pi-stef/atlassian
```

## Contents

- [Natural Language Usage](#natural-language-usage)
- [Auth](#auth)
- [Development CLI](#development-cli)
- [Jira Context](#jira-context)
- [Endpoint Notes](#endpoint-notes)

## Natural Language Usage

After credentials are configured, ask the agent for Jira or Confluence context in plain language:

```text
pi "Use the Atlassian tools to summarize Jira issue ABC-123 and any linked Confluence requirements before planning."
pi "Read this Confluence page and list implementation constraints before touching code: https://your-site.atlassian.net/wiki/..."
```

For exact local reads during development, use the CLI:

```bash
pnpm exec tsx packages/atlassian/bin/atlassian.ts jira ABC-123 --context
pnpm exec tsx packages/atlassian/bin/atlassian.ts confluence "https://your-site.atlassian.net/wiki/..."
```

## Auth

Set environment variables:

```bash
export ATLASSIAN_BASE_URL="https://your-site.atlassian.net"
export ATLASSIAN_EMAIL="you@example.com"
export ATLASSIAN_API_TOKEN="..."
```

`ATLASSIAN_DOMAIN=your-site.atlassian.net` may be used instead of `ATLASSIAN_BASE_URL`.

The package also supports config files. Config is read from:

1. `~/.pi/sf/atlassian/config.json` — Pi-conventional path

Malformed files fail fast. New setups should put credentials in `~/.pi/sf/atlassian/config.json`.

### Config file shape

Either `baseUrl` or `domain` is required (not both). `email` and `apiToken` are always required. Trailing slashes on `baseUrl` are normalized.

```json
{
  "baseUrl": "https://your-site.atlassian.net",
  "email": "you@example.com",
  "apiToken": "..."
}
```

Or the upstream-MCP-compatible `domain` form:

```json
{
  "domain": "your-site.atlassian.net",
  "email": "you@example.com",
  "apiToken": "..."
}
```

To create the recommended config file:

```bash
mkdir -p ~/.pi/sf/atlassian
cat > ~/.pi/sf/atlassian/config.json <<'JSON'
{
  "baseUrl": "https://your-site.atlassian.net",
  "email": "you@example.com",
  "apiToken": "..."
}
JSON
chmod 600 ~/.pi/sf/atlassian/config.json
```

The `chmod 600` step is recommended so the file is only readable by your user — the API token grants full Jira and Confluence access for the email's account.

## Development CLI

`tsx` is a workspace dev-dependency, not a global binary. Run the CLI through `pnpm exec` from the repo root so the local install is picked up:

```bash
pnpm exec tsx packages/atlassian/bin/atlassian.ts jira ABC-123
pnpm exec tsx packages/atlassian/bin/atlassian.ts jira ABC-123 --context
pnpm exec tsx packages/atlassian/bin/atlassian.ts story ABC-123
pnpm exec tsx packages/atlassian/bin/atlassian.ts confluence "https://your-site.atlassian.net/wiki/..."
pnpm exec tsx packages/atlassian/bin/atlassian.ts --stdin
```

Human subcommands print compact Markdown. `--stdin` accepts `{ "tool": "<toolName>", ...params }` and prints structured JSON.

## Jira Context

Use `story_context` when a Jira story should drive implementation work. It returns compact issue details, related Jira issues, linked Confluence pages, Figma URLs, external URL inventory, inaccessible same-site links, and traversal metadata under bounded caps.

```json
{
  "tool": "story_context",
  "key": "ABC-123",
  "maxDepth": 1,
  "maxJiraIssues": 10,
  "maxConfluencePages": 3,
  "includeExternalUrls": true
}
```

`jira_issue` remains available for compact single-issue context. Pass `includeContext: true` to use the same bounded traversal. `jira_get_issue` also accepts `includeContext: true` when a raw issue read should be upgraded to implementation context.

The walker follows same-site Jira browse links, Jira keys, and Confluence page links. It keeps Figma URLs as design-link inventory and, when `~/.pi/sf/figma/config.json` is configured, also fetches compact linked Figma context automatically.

Figma enrichment is bounded for Jira latency:

- `includeFigmaContext` defaults to auto: enabled only when Figma auth is configured.
- `includeFigmaContext: false` keeps only the URL inventory.
- `includeFigmaContext: true` records missing-auth feedback in `inaccessibleLinks` instead of failing the Jira context.
- `maxFigmaLinks` defaults to `2`, and links are fetched with concurrency `2`.
- Individual Figma failures are isolated; Jira and Confluence context still returns.

The walker does not fetch arbitrary non-Figma external sites by default.

## Endpoint Notes

- Confluence v2 does not currently cover every operation from the old API-key MCP package. CQL search, Confluence user search, and adding labels remain isolated in a legacy Confluence client using verified v1 endpoints.
- `jira_update_board` is registered for old MCP tool-name parity, but it always fails fast. Current Jira Software Cloud REST APIs document board configuration reads, not board name/filter updates. Create a new board with the desired filter, or update the underlying Jira filter separately.
