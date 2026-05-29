# SF Web Access

`@pi-stef/web` provides no-key web search, URL fetch, browser automation, login sessions, and CloakBrowser-backed page rendering as a Pi extension.

## Installation

```bash
pi install git:github.com/<USER>/pi-stef#packages/web --scope user
```

For project-local install:

```bash
pi install -l git:github.com/<USER>/pi-stef#packages/web
```

After installation, verify runtime dependencies:

```bash
pnpm --filter web check-runtime
```

Install the CloakBrowser browser binary when needed:

```bash
pnpm --filter web install-browser
```

## Contents

- [Natural Language Usage](#natural-language-usage)
- [Slash Commands](#slash-commands)
- [Tools](#tools)
- [Configuration](#configuration)
- [No-Key Search Setup](#no-key-search-setup)
- [Browser Identity](#browser-identity)
- [Security Notes](#security-notes)
- [Browser Tests](#browser-tests)
- [License](#license)

## Natural Language Usage

The agent understands natural-language requests and routes them to the correct tool. Examples:

**Search the web:**
```text
"Search for current browser automation options and summarize the top sources."
"What's the latest news on DFW weather?"
"Find recent articles about Rust web frameworks."
```
The agent calls `sf_web_search`.

**Fetch a specific URL:**
```text
"Fetch this URL as markdown: https://example.com/docs"
"Read the content of https://example.com and summarize it."
"Use the browser to fetch https://example.com (it needs JavaScript)."
```
The agent calls `sf_web_fetch`. Asking to "use the browser" forces `mode='browser'`.

**Run a browser flow:**
```text
"Use the browser to go to google.com, search for 'espresso machines', and extract the results."
"Open walmart.com, search for 'laptop deals', and click the first result."
"Navigate to example.com/login, fill in the username and password, and submit."
```
The agent calls `sf_web_flow`.

**Create a login session:**
```text
"Log into https://example.com using my credentials."
"Create a browser login session for the staging site."
```
The agent calls `sf_web_login`.

**Manage sessions:**
```text
"List my browser sessions."
"Clear the 'staging' browser session profile."
```
The agent calls `sf_web_session`.

## Slash Commands

Slash commands inject a prompt into the agent conversation. The agent then calls the corresponding tool.

| Command | Args | Example |
|---------|------|---------|
| `/sf-web-search` | `<query>` | `/sf-web-search DFW weather forecast` |
| `/sf-web-fetch` | `<url>` | `/sf-web-fetch https://example.com/docs` |
| `/sf-web-flow` | `<instruction>` | `/sf-web-flow go to google.com and search for Rust` |
| `/sf-web-login` | `<url>` | `/sf-web-login https://example.com/login` |
| `/sf-web-session` | `[action] [name]` | `/sf-web-session list` |
| `/sf-web` | `status` | `/sf-web status` |

If `/sf-web-search` is already registered by another package, the extension falls back to `/sf-search`.

## Tools

All tools use the `sf_web_` prefix to avoid collisions with other Pi extensions.

### sf_web_search

Search the web through a no-key provider cascade.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | integer (1-20) | no | Maximum results to return (default: 10) |
| `providers` | string[] | no | Ordered provider list: `searxng`, `searxng-html`, `duckduckgo`, `google`, `bing` |
| `searxngUrl` | string | no | SearXNG instance URL override |
| `headless` | boolean | no | Headless browser mode (default: true) |
| `profile` | string | no | Browser profile name for browser-backed providers |

### sf_web_fetch

Fetch a specific URL. Defaults to fast HTTP; falls back to CloakBrowser for JS-heavy pages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | URL to fetch |
| `format` | string | no | Output format: `markdown`, `text`, `html`, `json`, `raw` (default: `markdown`) |
| `mode` | string | no | Fetch mode: `auto`, `fast`, `browser` (default: `auto`) |
| `headless` | boolean | no | Headless browser mode (default: true) |
| `profile` | string | no | Browser profile name for rendered fetches |
| `screenshot` | boolean | no | Capture a screenshot when browser mode is used |
| `selector` | string | no | CSS selector to extract from HTML pages |

`mode` values:
- `auto` — tries fast HTTP first, falls back to browser if JS-heavy or blocked
- `fast` — HTTP only, no browser fallback
- `browser` — always uses CloakBrowser rendering

### sf_web_flow

Automate multi-step browser interactions in CloakBrowser. Accepts natural-language instructions or structured step arrays.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instruction` | string | no | Natural-language flow instruction |
| `steps` | array | no | Structured step array (see below) |
| `headless` | boolean | no | Headless browser mode (default: true) |
| `profile` | string | no | Browser profile name |

Either `instruction` or `steps` must be provided.

**Natural-language instruction examples:**
```text
"go to google.com and search for espresso machines"
"open example.com then click 'About' then wait 2s"
"navigate to https://example.com/login; type 'user@example.com' in input[name='email']; press Enter"
```

**Structured step actions:**

| Action | Fields | Description |
|--------|--------|-------------|
| `goto` / `navigate` / `open` | `url` | Navigate to URL |
| `click` | `selector`, or `role` + `name`, or `text` | Click an element |
| `type` / `fill` | `text`, optional `selector` | Type text into an input |
| `press` / `keypress` / `key` | `key`, optional `selector` | Press a keyboard key |
| `wait` | `ms` | Wait in milliseconds (0-120000) |
| `screenshot` | `path` | Capture screenshot to file |
| `extract` | `selector`, optional `count` | Extract text content from matching elements |

### sf_web_login

Create or refresh a named CloakBrowser login profile. Credentials come from environment variables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | Login page URL |
| `profile` | string | no | Browser profile name (default: `default`) |
| `interactive` | boolean | no | Open a headed browser for manual login |
| `interactiveWaitMs` | integer (1000-600000) | no | Wait time for interactive login |
| `usernameEnv` | string | no | Env var name containing username (default: `SF_WEB_USERNAME`) |
| `passwordEnv` | string | no | Env var name containing password (default: `SF_WEB_PASSWORD`) |
| `headless` | boolean | no | Headless browser mode (default: true) |

### sf_web_session

List, inspect, locate, or clear CloakBrowser session profiles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | no | `list`, `inspect`, `locate`, or `clear` (default: `list`) |
| `profile` | string | no | Profile name (default: `default`) |
| `yes` | boolean | no | Confirm destructive clear action |

## Configuration

Configuration is loaded from four layers, merged with later layers overriding earlier:

1. **Hardcoded defaults**
2. **Config file**: `~/.pi/web/config.json` (or `$SF_WEB_CONFIG`)
3. **Environment variables**: `SF_WEB_*`
4. **Runtime parameters**: passed directly to tool calls

### Config File

Location: `~/.pi/web/config.json` (override with `SF_WEB_CONFIG`).

```json
{
  "maxResults": 10,
  "searchProviders": ["searxng", "duckduckgo", "google", "bing"],
  "searxngUrl": "https://search.example.com",
  "allowPrivateNetworks": false,
  "fetchMaxBytes": 2097152,
  "fetchTimeoutMs": 15000,
  "maxBytes": 51200,
  "maxLines": 2000,
  "outputDir": "/tmp/sf-web",
  "profilesDir": "~/.pi/web/profiles",
  "userAgent": "Mozilla/5.0 ...",
  "browserFingerprintSeed": "42",
  "browserHumanPreset": "default",
  "browserLocale": "en-US",
  "browserTimezone": "America/New_York",
  "browserProxy": "socks5://proxy:1080",
  "browserGeoip": false
}
```

### Environment Variables

| Env Var | Config Key | Type | Default | Description |
|---------|-----------|------|---------|-------------|
| `SF_WEB_CONFIG` | — | string | `~/.pi/web/config.json` | Config file path |
| `SF_WEB_SEARXNG_URL` | `searxngUrl` | string | — | SearXNG instance URL |
| `SF_WEB_SEARCH_PROVIDERS` | `searchProviders` | CSV | `searxng,duckduckgo,google,bing` | Ordered search providers |
| `SF_WEB_MAX_RESULTS` | `maxResults` | integer | 10 | Default max search results |
| `SF_WEB_MAX_BYTES` | `maxBytes` | integer | 51200 | Max tool output bytes |
| `SF_WEB_MAX_LINES` | `maxLines` | integer | 2000 | Max tool output lines |
| `SF_WEB_FETCH_MAX_BYTES` | `fetchMaxBytes` | integer | 2097152 | Max HTTP body bytes |
| `SF_WEB_FETCH_TIMEOUT_MS` | `fetchTimeoutMs` | integer | 15000 | HTTP fetch timeout (ms) |
| `SF_WEB_ALLOW_PRIVATE_NETWORKS` | `allowPrivateNetworks` | boolean | false | Allow private/loopback IPs |
| `SF_WEB_OUTPUT_DIR` | `outputDir` | string | `$TMPDIR/sf-web` | Output file directory |
| `SF_WEB_PROFILES_DIR` | `profilesDir` | string | `~/.pi/web/profiles` | Browser profiles directory |
| `SF_WEB_USER_AGENT` | `userAgent` | string | Chrome 124 UA | HTTP user-agent (fast fetch only) |
| `SF_WEB_BROWSER_FINGERPRINT_SEED` | `browserFingerprintSeed` | string | auto | Fingerprint seed (positive integer) |
| `SF_WEB_BROWSER_HUMAN_PRESET` | `browserHumanPreset` | string | — | `default` or `careful` |
| `SF_WEB_BROWSER_LOCALE` | `browserLocale` | string | — | Browser locale (e.g., `en-US`) |
| `SF_WEB_BROWSER_TIMEZONE` | `browserTimezone` | string | — | Browser timezone (e.g., `America/New_York`) |
| `SF_WEB_BROWSER_PROXY` | `browserProxy` | string | — | Proxy URL (`http:`, `https:`, or `socks5:`) |
| `SF_WEB_BROWSER_GEOIP` | `browserGeoip` | boolean | — | Enable GeoIP (requires CloakBrowser support) |
| `SF_WEB_USERNAME` | — | string | — | Default username for `sf_web_login` |
| `SF_WEB_PASSWORD` | — | string | — | Default password for `sf_web_login` |
| `SF_WEB_SENSITIVE_QUERY_KEYS` | `sensitiveQueryKeys` | CSV | built-in list | Additional URL params to redact from errors |

## No-Key Search Setup

Search works without API keys by default. Configure a SearXNG instance for best results:

```bash
export SF_WEB_SEARXNG_URL="https://search.example.com"
```

Provider cascade:

```text
SearXNG JSON → SearXNG HTML → DuckDuckGo HTML/Lite → Google (browser) → Bing (browser)
```

Each provider is tried in order. The first to return results wins. Google and Bing require CloakBrowser and are last-resort fallbacks.

## Browser Identity

Browser mode uses CloakBrowser for fingerprint management. Named profiles get a stable derived fingerprint seed.

For first-run challenges, use headed mode once, complete the challenge manually, then reuse the profile in headless mode.

Browser hardening is config-only (not tool parameters):

| Setting | Config Key | Notes |
|---------|-----------|-------|
| Fingerprint seed | `browserFingerprintSeed` | Positive integer; auto-derived from profile name if omitted |
| Human preset | `browserHumanPreset` | `default` or `careful` |
| Locale | `browserLocale` | e.g., `en-US` |
| Timezone | `browserTimezone` | e.g., `America/New_York` |
| Proxy | `browserProxy` | `http:`, `https:`, or `socks5:` URL |
| GeoIP | `browserGeoip` | Requires CloakBrowser's optional GeoIP support |

## Security Notes

- Only `http:` and `https:` URLs are allowed.
- Private, loopback, link-local, multicast, and reserved IP ranges are blocked by default.
- Fast fetch re-validates redirects before reading the body.
- Browser profiles contain cookies and session tokens. Clear them when no longer needed.
- `sf_web_login` does not accept raw passwords. Use interactive login or environment variable names.

## Browser Tests

Real browser tests are skipped by default. Run them when intentionally testing CloakBrowser:

```bash
SF_WEB_RUN_BROWSER_TESTS=1 pnpm exec vitest run packages/web/tests/browserSmoke.test.ts
SF_WEB_RUN_BROWSER_TESTS=1 pnpm exec vitest run packages/web/tests/tools.e2e.test.ts
```

## License

Runtime dependencies:

| Package | Purpose | License |
|---------|---------|---------|
| `cloakbrowser` | CloakHQ browser launcher/runtime | MIT |
| `playwright-core` | Browser automation API | Apache-2.0 |
| `defuddle` | Clean article extraction | MIT |
| `@mozilla/readability` | Readability fallback extraction | Apache-2.0 |
| `turndown` | HTML to Markdown conversion | MIT |
| `jsdom` | Server-side DOM for extraction | MIT |
| `@sinclair/typebox` | JSON schema type builder | MIT |
