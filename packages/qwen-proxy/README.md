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
| `SF_QWEN_RATE_LIMIT_COOLDOWN_MS` | `86400000` (24h) | Rate-limit cooldown duration |
| `SF_QWEN_EMPTY_COOLDOWN_MS` | `10000` (10s) | Flat pool cooldown applied only AFTER inline empty-retries are exhausted |
| `SF_QWEN_EMPTY_RETRY_MAX` | `3` | Inline retries on an empty completion (Baxia CAPTCHA flag) before giving up. `0` disables (immediate cooldown) |
| `SF_QWEN_EMPTY_RETRY_GAP_MS` | `1000` (1s) | Sleep between inline empty-retry attempts |
| `SF_QWEN_MIN_REQUEST_GAP_MS` | `4000` (4s) | Global look-human throttle (±50% jitter); `0` disables |
| `SF_QWEN_MAX_CONCURRENCY` | `1` | Max in-flight chat.qwen.ai calls (1 = serialize, like the web chat). Baxia flags the IP on concurrent upstream connections; raise only if you accept that risk |
| `SF_QWEN_MODEL_ALIASES` | *(unset)* | JSON object mapping alias → upstream model |
| `SF_QWEN_LOG_LEVEL` | `info` | Log level |
| `SF_QWEN_USE_CHROME_BAXIA` | `true` | Use headless Chromium (Chrome CDP) for Baxia tokens |
| `SF_QWEN_CHROME_PATH` | *(unset)* | Path to Chrome/Chromium; unset → autodetect (`/usr/bin/chromium` in Docker) |
| `SF_QWEN_BAXIA_CACHE_TTL_MS` | `1500000` (25min) | Baxia token cache TTL |
| `SF_QWEN_BAXIA_VERSION` | `2.5.37` | Baxia `bx-v` version |
| `SF_QWEN_BAXIA_PRE_WARM` | `true` | Eagerly fetch the first token at startup (exit 1 on failure) |
| `SF_QWEN_BAXIA_FALLBACK` | `false` | Return last-known token on fetch failure |

See the [full documentation](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) for architecture, API surface, and known limitations.

---

## Documentation

- [Service docs](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) — configuration, API surface, architecture, known limitations
- [Docker guide](https://sfiorini.github.io/pi-stef/packages/qwen-proxy-docker) — deployment, volumes, reverse-proxy setup

---

## License

[MIT](../../LICENSE)
