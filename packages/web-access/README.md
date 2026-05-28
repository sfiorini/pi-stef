# Web Access

`@pi-stef/web-access` is a First Horizon Pi extension for no-key web search, URL fetch, rendered scraping, browser sessions, login flows, screenshots, and CloakBrowser-backed page access.

The package is optional. Install it when an agent needs web retrieval beyond the normal model context.

```bash
fh-agent install web-access --scope project
fh-agent install web-access --scope global
```

Use `--dry-run` first when you want to inspect package-local dependency prep:

```bash
fh-agent install web-access --scope project --dry-run
```

The package uses `runtimePostInstallCommands` so CloakBrowser binary preparation runs after package-local `npm install --omit=peer --workspaces=false` has installed `cloakbrowser` and `playwright-core`.

## Contents

- [Natural Language Usage](#natural-language-usage)
- [Tools](#tools)
- [No-Key Search Setup](#no-key-search-setup)
- [Browser Identity](#browser-identity)
- [CloakBrowser Footprint](#cloakbrowser-footprint)
- [Provenance And License Notes](#provenance-and-license-notes)
- [Security Notes](#security-notes)
- [Browser Test](#browser-test)

## Natural Language Usage

Use natural language when the agent needs current web context, URL extraction, rendered pages, or browser sessions:

```text
fh-agent "Use web-access to search for current browser automation options and summarize the top sources with links."
fh-agent "Fetch this URL as markdown with web-access, then compare it with the local README: https://example.com/docs"
fh-agent "Use a named browser profile to open the staging login page and capture the visible error."
```

Use exact tools when you need deterministic parameters:

```text
fh_web_search query="current Figma REST API rate limits" maxResults=5
fh_web_fetch url="https://example.com/docs" format="markdown" mode="auto"
fh_web_flow instruction="go to example.com and search for pricing" profile="research"
```

## Tools

The extension uses namespaced First Horizon tool names to avoid collisions with common Pi packages:

| Tool | Purpose |
|---|---|
| `fh_web_search` | Search the web through no-key providers. |
| `fh_web_fetch` | Fetch one URL as markdown, text, HTML, JSON, or raw output. |
| `fh_web_flow` | Run deterministic browser steps such as goto, click, type, press, wait, screenshot, and extract. |
| `fh_web_login` | Create or refresh a named browser login profile. |
| `fh_web_session` | List, inspect, locate, or clear session/profile state. |

Slash commands:

```text
/search <query>
/web-search <query>
/web status
/web sessions
/web clear-session <name> [--yes]
```

`/search` is preferred when available. `/web-search` is the fallback when another package owns `/search`.

### Tool Parameters

| Tool | Required | Optional | Notes |
|---|---|---|---|
| `fh_web_search` | `query` | `maxResults`, `providers`, `searxngUrl`, `profile`, `headless` | Uses SearXNG when configured, then DuckDuckGo HTML/Lite, then CloakBrowser-backed Google/Bing providers when selected or reached by the cascade. |
| `fh_web_fetch` | `url` | `format`, `mode`, `selector`, `screenshot`, `profile`, `headless` | `format` is `markdown`, `text`, `html`, `json`, or `raw`. `mode` is `auto`, `fast`, or `browser`. |
| `fh_web_flow` | `instruction` or `steps` | `profile`, `headless` | Supports `goto`/`navigate`/`open`, `click`, `type`/`fill`, `press`/`keypress`/`key`, `wait`, `screenshot`, and `extract`. Host-only instructions such as `go to walmart.com and search for espresso machines` are normalized to HTTPS flow steps. |
| `fh_web_login` | `url` | `profile`, `interactive`, `interactiveWaitMs`, `usernameEnv`, `passwordEnv`, `headless` | Does not accept raw passwords. Defaults to `FH_WEB_USERNAME` and `FH_WEB_PASSWORD`. |
| `fh_web_session` | None | `action`, `profile`, `yes` | `action` is `list`, `inspect`, `locate`, or `clear`. `clear` requires `yes: true`. |

### Fetch Limits

`FH_WEB_MAX_BYTES` controls returned tool output size and temp-file spillover. `FH_WEB_FETCH_MAX_BYTES` controls the larger network body cap used before extraction. The default fetch cap is 2 MB so normal news pages can be extracted while agent output remains bounded.

### Runtime Checks

After installation, verify package-local runtime imports:

```bash
cd packages/web-access
npm run check-runtime
```

Install or update the CloakBrowser browser binary manually when needed:

```bash
cd packages/web-access
npm run install-browser
```

## No-Key Search Setup

Search works without API keys by default. Configure a SearXNG instance when you have one:

```bash
export FH_WEB_SEARXNG_URL="https://search.example.com"
```

The provider cascade is:

```text
SearXNG JSON -> SearXNG HTML -> DuckDuckGo HTML/Lite -> Google browser scrape -> Bing browser scrape
```

Public search pages can throttle or block automation. Google and Bing scraping are last-resort fallbacks and may require manual intervention when a consent or challenge page appears.

## Browser Identity

Browser mode lets CloakBrowser manage the browser user agent and fingerprint by default. `FH_WEB_USER_AGENT` is used only by the fast HTTP fetch path; forcing it into CloakBrowser can create inconsistent browser signals.

Named profiles get a stable derived fingerprint seed so repeat visits look like the same returning browser. Use site-specific profiles for sensitive sites:

```json
{
  "profile": "walmart",
  "headless": false
}
```

For first-run challenges, use headed mode once, complete the challenge manually, then reuse the same named profile in headless mode. CloakBrowser prevents many challenges from appearing, but it does not solve CAPTCHAs or replace proxy/IP reputation.

Config-only browser hardening knobs:

| Env var | Config key | Notes |
|---|---|---|
| `FH_WEB_BROWSER_FINGERPRINT_SEED` | `browserFingerprintSeed` | Optional positive integer. If omitted, fh-agent derives a stable seed from the profile name. |
| `FH_WEB_BROWSER_HUMAN_PRESET` | `browserHumanPreset` | `default` or `careful`. |
| `FH_WEB_BROWSER_LOCALE` | `browserLocale` | Example: `en-US`. |
| `FH_WEB_BROWSER_TIMEZONE` | `browserTimezone` | Example: `America/New_York`. |
| `FH_WEB_BROWSER_PROXY` | `browserProxy` | `http:`, `https:`, or `socks5:` proxy URL. This is intentionally config-only, not a tool parameter. |
| `FH_WEB_BROWSER_GEOIP` | `browserGeoip` | `true` or `false`; requires CloakBrowser's optional GeoIP support. |

## CloakBrowser Footprint

Verified with:

```bash
npm view cloakbrowser version license repository.url engines os cpu peerDependencies --json
```

Current npm metadata on 2026-05-20:

```json
{
  "version": "0.3.29",
  "license": "MIT",
  "repository.url": "git+https://github.com/CloakHQ/cloakbrowser.git",
  "engines": {
    "node": ">=20.0.0"
  },
  "peerDependencies": {
    "mmdb-lib": ">=2.0.0",
    "playwright-core": ">=1.53.0",
    "puppeteer-core": ">=21.0.0",
    "socks-proxy-agent": ">=10.0.0"
  }
}
```

CloakBrowser's public README documents a first-launch browser cache under `~/.cloakbrowser` and platform support for Linux x86_64/arm64, macOS arm64/x86_64, and Windows x86_64. Expect roughly a browser-sized download the first time the runtime installs or updates the browser binary.

## Provenance And License Notes

This package is a First Horizon implementation inspired by the internal `web-automation` skill in `/Users/stefano.fiorini/Documents/projects/ai-coding-skills`, plus the current Pi `fetch` package ecosystem. The source skill had no `LICENSE`, `NOTICE`, or `COPYING` file during planning, so implementation should re-create behavior from documented requirements unless internal provenance is confirmed.

Runtime dependencies:

| Package | Purpose | License |
|---|---|---|
| `cloakbrowser` | CloakHQ browser launcher/runtime integration. | MIT |
| `playwright-core` | Browser automation API used by CloakBrowser. | Apache-2.0 |
| `defuddle` | Clean article extraction. | MIT |
| `@mozilla/readability` | Readability fallback extraction. | Apache-2.0 |
| `turndown` | HTML to Markdown conversion. | MIT |
| `jsdom` | Server-side DOM for extraction. | MIT |

## Security Notes

- Only `http:` and `https:` URLs are in scope.
- Private, loopback, link-local, multicast, and reserved IP ranges are blocked by default.
- Fast fetch re-validates redirects before reading the body. Browser mode validates requested navigation targets before handing them to CloakBrowser; treat redirects and authenticated browsing as sensitive.
- Browser profiles can contain cookies and session tokens. Use named profiles sparingly and clear them when no longer needed.
- `fh_web_login` does not accept raw password values as tool parameters. Use interactive login or environment variable names.
- Windows profile permissions are best-effort and rely on the user's normal account isolation.

## Browser Test

The real browser tests are skipped by default. Run them only when you intentionally want to launch CloakBrowser:

```bash
FH_WEB_RUN_BROWSER_TESTS=1 pnpm test -- --run packages/web-access/tests/browserSmoke.test.ts
FH_WEB_RUN_BROWSER_TESTS=1 pnpm test -- --run packages/web-access/tests/tools.e2e.test.ts
```
