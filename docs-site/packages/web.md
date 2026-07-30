# web

`@pi-stef/web` provides no-key web search, URL fetch, browser automation, login sessions, and CloakBrowser-backed page rendering as a Pi extension.

## Installation

```bash
pi install npm:@pi-stef/web
```

After installation, verify runtime dependencies:

```bash
pnpm --filter web check-runtime
```

## Natural Language Usage

```text
"Search for current browser automation options."
"Fetch this URL as markdown: https://example.com/docs"
"Use the browser to go to google.com and search for espresso machines."
"Log into https://example.com using my credentials."
```

## Tools

### sf_web_search

Search the web through a no-key provider cascade.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | integer (1-20) | no | Maximum results (default: 10) |
| `providers` | string[] | no | Ordered provider list |

### sf_web_fetch

Fetch a specific URL. Falls back to CloakBrowser for JS-heavy pages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | URL to fetch |
| `format` | string | no | `markdown`, `text`, `html`, `json`, `raw` |
| `mode` | string | no | `auto`, `fast`, `browser` |

### sf_web_flow

Automate multi-step browser interactions.

```text
"Go to google.com and search for espresso machines"
"Navigate to example.com/login; type credentials; press Enter"
```

### sf_web_login

Create or refresh a named CloakBrowser login profile.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | Login page URL |
| `profile` | string | no | Browser profile name |

## Authenticated browsing with sf_web_login profiles

For sites behind a login (e.g. a Confluence instance requiring SAML SSO), create a named profile once, then fetch with it:

````text
sf_web_login   { url, profile: "confluence" }                        # once — stores cookies
sf_web_fetch   { url, profile: "confluence", mode: "browser" }       # renders with the stored session
sf_web_session { action: "list" }                                    # inspect stored profiles
````

Re-run `sf_web_login` when sessions expire (you'll see redirects to a login page). For Confluence/Jira, prefer the native `@pi-stef/atlassian` tools when they work — they're faster and return structured content; use `sf_web_*` as the SSO fallback. A flow agent using these needs `extensions: [web]` + `isolated: false` in its frontmatter. See [Agent Isolation & Auth](/guides/agent-isolation-and-auth).

## No-Key Search Setup

Search works without API keys. Configure SearXNG for best results:

```bash
export SF_WEB_SEARXNG_URL="https://search.example.com"
```

Provider cascade: SearXNG JSON → SearXNG HTML → DuckDuckGo → Google (browser) → Bing (browser)

## Configuration

Location: `~/.pi/web/config.json`

```json
{
  "maxResults": 10,
  "searchProviders": ["searxng", "duckduckgo", "google", "bing"],
  "fetchMaxBytes": 2097152,
  "fetchTimeoutMs": 15000
}
```

## Security Notes

- Only `http:` and `https:` URLs are allowed
- Private, loopback, link-local, multicast, and reserved IP ranges blocked by default
- Browser profiles contain cookies and session tokens — clear when no longer needed
