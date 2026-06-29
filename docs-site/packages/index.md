# Packages

All packages are published to npm under the `@pi-stef` scope. Install any package individually with:

```bash
pi install npm:@pi-stef/<package-name>
```

Or manage them declaratively with the [catalog](/packages/catalog).

## Package List

| Package | Description |
|---------|-------------|
| [azure-foundry](/packages/azure-foundry) | Azure Foundry and Azure OpenAI deployments as native Pi providers |
| [catalog](/packages/catalog) | Declarative package manager with cross-machine sync |
| [cursor](/packages/cursor) | Cursor AI editor as a native Pi stream provider |
| [team](/packages/team) | Steerable team of role-agents for plan/review/implement |
| [atlassian](/packages/atlassian) | Jira and Confluence integration |
| [figma](/packages/figma) | Figma REST API tools and design context |
| [pair](/packages/pair) | Simplified plan/review/implement with pi-subagents |
| [web](/packages/web) | Web search, URL fetch, and browser automation |
| [finance](/packages/finance) | Portfolio tracking, drift analysis, and investment suggestions |
| [finance-api](/packages/finance-api) | Always-on local service for financial data ingestion and quant analysis |
| [paths](/packages/paths) | Shared path conventions (internal) |
| agent-workflows | Workflow engine primitives (internal, not user-installed) |

## Internal Packages

- **paths** — Shared path conventions used by other packages. Not typically installed directly.
- **agent-workflows** — Internal workflow engine. Used by `team` and other packages. Not user-installed.
