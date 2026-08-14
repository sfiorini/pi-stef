# @pi-stef/qwen-proxy

Guest-mode proxy for [chat.qwen.ai](https://chat.qwen.ai) with OpenAI + Anthropic compatibility. No Qwen account required — the proxy handles Baxia anti-bot tokens via headless Chromium (Chrome CDP).

---

## Quick start

### Docker (recommended)

```bash
cd packages/qwen-proxy/docker
SF_QWEN_API_KEY=your-secret-key docker compose up -d
```

Pulls `ghcr.io/sfiorini/pi-stef/qwen-proxy:latest` and starts the proxy on port 7790. See the [Docker guide](docker/README.md) for details, volumes, image tags, and reverse-proxy setup.

### Native

```bash
pnpm --filter @pi-stef/qwen-proxy dev
```

### Verify

```bash
curl http://127.0.0.1:7790/v1/health
# {"status":"ok"}
```

---

## Features

- **Guest mode** — no Qwen account or login required; the proxy talks directly to chat.qwen.ai
- **Baxia anti-bot tokens** — headless Chromium (Chrome CDP) fetches `__baxia__` tokens; 25-minute cache with background refresh and pre-warm at startup
- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`
- **Anthropic-compatible API** — `/v1/messages` with `claude-*` model fallback to `qwen3-max`
- **Tool calling** — OpenAI-style `tools`/`tool_choice` (upstream prompt-engineering translation)
- **Model aliases** — map friendly names to upstream Qwen models (e.g. `gpt-4o` → `qwen3-max`)
- **Global throttle** — `SF_QWEN_MIN_REQUEST_GAP_MS` paces all requests (±50% jitter) to look human
- **Inline retry-on-empty** — retries empty completions up to `SF_QWEN_EMPTY_RETRY_MAX` (default 3, `SF_QWEN_EMPTY_RETRY_GAP_MS` gap) before a flat 10s pool cooldown
- **Admin dashboard** — `/admin` with Baxia cache-status panel (optional, gated by `SF_QWEN_ADMIN_KEY`)
- **Docker** — multi-arch image (`linux/amd64`, `linux/arm64`) on GHCR, non-root uid 1000, bundled Chromium + fonts

---

## Configuration

All configuration is via environment variables (prefix `SF_QWEN_`).

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Server bind host |
| `SF_QWEN_PORT` | `7790` | Server port |
| `SF_QWEN_DB` | `./data/qwen-proxy.db` (`/data/qwen-proxy.db` in Docker) | SQLite database path |
| `SF_QWEN_API_KEY` | *(required)* | Client API keys, comma-separated |
| `SF_QWEN_ADMIN_KEY` | *(unset)* | Admin dashboard key; unset → `/admin` returns 404 (D15) |
| `SF_QWEN_EMPTY_COOLDOWN_MS` | `10000` (10s) | Flat pool cooldown applied only AFTER inline empty-retries are exhausted |
| `SF_QWEN_EMPTY_RETRY_MAX` | `3` | Inline retries on an empty completion (Baxia CAPTCHA flag) before giving up. `0` disables (immediate cooldown) |
| `SF_QWEN_EMPTY_RETRY_GAP_MS` | `1000` (1s) | Sleep between inline empty-retry attempts |
| `SF_QWEN_MIN_REQUEST_GAP_MS` | `4000` (4s) | Global look-human throttle (±50% jitter); `0` disables |
| `SF_QWEN_MAX_CONCURRENCY` | `1` | Max in-flight chat.qwen.ai calls (1 = serialize, like the web chat). Baxia flags the IP on concurrent upstream connections; raise only if you accept that risk |
| `SF_QWEN_PROXY_COUNT` | `0` | Proxy pool size for NordVPN SOCKS5 rotation. `0` = legacy (single-IP, no rotation); `>1` = enable rotation across N proxies |
| `SF_QWEN_PROXY_URLS` | *(unset)* | Comma-separated SOCKS5 proxy URLs (overrides auto-discovery; e.g. `socks5://user:pass@host:1080,...`) |
| `SF_QWEN_PROXY_USER` | *(unset)* | NordVPN service username (used for auto-discovery; ignored if `SF_QWEN_PROXY_URLS` is set) |
| `SF_QWEN_PROXY_PASS` | *(unset)* | NordVPN service password |
| `SF_QWEN_PROXY_COUNTRIES` | *(unset)* | Comma-separated country codes for auto-discovery (e.g. `us,de,gb`) |
| `SF_QWEN_TIMEOUT_MS` | `60000` | TTFB timeout in ms — aborts if no response headers arrive within this window (cleared on headers, never aborts mid-stream) |
| `SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS` | `30000` | Abort an upstream completion that produces no payload chunk within this many ms after headers (`0` disables). The abort throws EmptyCompletionError → token eviction + proxy rotation, and always releases the concurrency slot |
| `SF_QWEN_STREAM_IDLE_TIMEOUT_MS` | `30000` | Abort an upstream stream that goes silent for this many ms after content started flowing (`0` disables). Ends the response gracefully with the partial content — no token eviction |
| `SF_QWEN_MODEL_ALIASES` | *(unset)* | JSON object mapping alias → upstream model |
| `SF_QWEN_LOG_LEVEL` | `info` | Log level |
| `SF_QWEN_CHROME_PATH` | *(unset)* | Path to Chrome/Chromium; unset → autodetect (`/usr/bin/chromium` in Docker) |
| `SF_QWEN_BAXIA_CACHE_TTL_MS` | `1500000` (25min) | Baxia token cache TTL |
| `SF_QWEN_BAXIA_READINESS_TIMEOUT_MS` | `30000` (30s) | Max wait for Baxia SDK readiness per token mint (`chrome-error://` pages abort instantly); clamped ≥5000 |
| `SF_QWEN_BAXIA_VERSION` | `2.5.37` | Baxia `bx-v` version |
| `SF_QWEN_BAXIA_PRE_WARM` | `true` | Eagerly fetch the first token at startup (exit 1 on failure) |
| `SF_QWEN_BAXIA_FALLBACK` | `false` | Return last-known token on fetch failure |

See the [full documentation](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) for architecture, API surface, and known limitations.

---

## Proxy rotation (NordVPN SOCKS5 pool)

By default the proxy uses a single IP for all upstream requests. When Qwen's Baxia anti-bot flags that IP, every subsequent request hits the same ceiling — retries rotate the same token but the IP stays the same.

**Rotation mode** (`SF_QWEN_PROXY_COUNT > 1` or `SF_QWEN_PROXY_URLS` set) distributes completion requests across N SOCKS5 proxies. Each proxy is tried once per request (budget = N); if all N are exhausted (empty / network / 5xx), the proxy returns 429 with a cooldown.

### How it works

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Legacy** (N ≤ 1) | — | Single IP; `SF_QWEN_EMPTY_RETRY_MAX` inline retries + `SF_QWEN_EMPTY_COOLDOWN_MS` cooldown |
| **Rotation** (N > 1) | `emptyRetryMax` ignored | Rotate on empty/network/5xx; budget = N attempts; all-burned → 429 + cooldown |

- **Rotate triggers:** `EmptyCompletionError`, `NetworkError` (TTFB timeout, connection reset), `ServerError` (5xx), `TypeError` (fetch internals), raw `Error` (e.g. SOCKS connect failure).
- **Terminal (no rotate):** `ClientError` (4xx, incl. `data_inspection_failed`), `RateLimitError` (429), `UnknownError`.
- **Token generation is proxy-affine** — in rotation mode, a local loopback SOCKS5 bridge injects NordVPN credentials for Chromium; Baxia tokens are cached per-proxy so the token's issuing IP matches the completion's egress IP. Legacy (N≤1) still generates tokens directly.
- **Stream rotation is pre-first-content only** — once the first content token has been yielded to the client, no rotation occurs (would duplicate already-sent chunks). A post-content error surfaces directly.
- **No `refreshBaxiaToken`** on rotation exhaustion — the token is fine; the IP ceiling is the bottleneck.

### Setup

1. **NordVPN service credentials** — obtain from [my.nordaccount.com](https://my.nordaccount.com) → Service credentials (not your NordVPN account password).
2. **Auto-discovery** (recommended): set `SF_QWEN_PROXY_USER` + `SF_QWEN_PROXY_PASS`; the proxy queries `api.nordvpn.com` for SOCKS5 servers, sorted by load, filtered by `SF_QWEN_PROXY_COUNTRIES` if set. Takes the N lowest-load servers.
3. **Explicit URLs**: set `SF_QWEN_PROXY_URLS` (comma-separated, e.g. `socks5://user:pass@host1:1080,socks5://user:pass@host2:1080`). Overrides auto-discovery.
4. **Docker**: the image now depends on `socks-proxy-agent`; ensure outbound port 1080 is open.

### Graceful degradation

- If discovery returns fewer servers than `SF_QWEN_PROXY_COUNT`, the proxy uses what it got (with a warning).
- If discovery returns 0 usable servers (or credentials are missing), the proxy falls back to legacy mode silently.
- If `SF_QWEN_PROXY_COUNT ≤ 1` and no explicit URLs, legacy mode applies (byte-for-byte backward-compatible).

### Per-proxy token affinity (resolved)

Token generation now egresses through the same SOCKS5 proxy as completion requests. A pure-Node loopback SOCKS5 bridge (`net.Server` + `socks`) binds `127.0.0.1`, injects NordVPN credentials, and routes Chromium through it. Tokens are cached per-proxy key. Legacy mode (no proxy pool) remains byte-for-byte unchanged.

---

## Documentation

- [Service docs](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) — configuration, API surface, architecture, known limitations
- [Docker guide](https://sfiorini.github.io/pi-stef/packages/qwen-proxy-docker) — deployment, volumes, reverse-proxy setup

---

## License

[MIT](../../LICENSE)
