# qwen-proxy

Guest-mode proxy for [chat.qwen.ai](https://chat.qwen.ai) with OpenAI + Anthropic compatibility. No Qwen account required — the proxy handles Baxia anti-bot tokens via headless Chromium (Chrome CDP).

## Quick start

### Docker (recommended)

```bash
cd packages/qwen-proxy/docker
SF_QWEN_API_KEY=your-secret-key docker compose up -d
```

Pulls `ghcr.io/sfiorini/pi-stef/qwen-proxy:latest` and starts the proxy on port 7790. See the [Docker guide](./qwen-proxy-docker) for details, volumes, image tags, and reverse-proxy setup.

### Native

```bash
pnpm --filter @pi-stef/qwen-proxy dev
```

### Verify

```bash
curl http://127.0.0.1:7790/v1/health
# {"status":"ok"}
```

## What it does

qwen-proxy is an always-on reverse proxy that sits between your AI client (pi, OpenAI SDK, Anthropic SDK, or any HTTP client) and [chat.qwen.ai](https://chat.qwen.ai). It provides:

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

## Architecture

### Request flow

```
SDK client ──Bearer SF_QWEN_API_KEY──▶ proxy (7790)
                                        │ [Chromium CDP → __baxia__ tokens]
                                        ▼ chat.qwen.ai (bx-* headers)
```

The proxy runs in **guest mode** — no Qwen account or JWT login is required. `BaxiaTokenManager` spawns headless Chromium via Chrome CDP, navigates to chat.qwen.ai, and extracts `window.__baxia__` tokens. Tokens are cached for 25 minutes and refreshed in the background. Each API request includes the Baxia token as `bx-*` headers.

### Baxia anti-bot & CAPTCHA flagging

chat.qwen.ai is fronted by the **Baxia** anti-bot, which flags automated traffic and demands CAPTCHA solves. The proxy defends against this:

1. **Headless Chromium tokens** — `BaxiaTokenManager` uses Chrome CDP to generate valid `__baxia__` tokens, bypassing the anti-bot gate. Tokens are pre-warmed at startup and refreshed every 25 minutes.
2. **Look-human throttle** — `SF_QWEN_MIN_REQUEST_GAP_MS` (default 4 s, ±50 % jitter) paces all requests so the cadence isn't metronomic. Set `0` to disable. Expect slower responses; tune down if flagging is rare.
3. **Inline retry-on-empty** — when the upstream returns an empty completion (Baxia CAPTCHA flag), the proxy retries the same request inline up to `SF_QWEN_EMPTY_RETRY_MAX` (default 3) with a `SF_QWEN_EMPTY_RETRY_GAP_MS` sleep (default 1s). The transient flag usually lifts mid-retry, converting would-be-empties into successes. Only after retries are exhausted does the proxy apply a short flat pool cooldown (`SF_QWEN_EMPTY_COOLDOWN_MS`, default 10s) + return 429 (stream paths that already committed HTTP 200 degrade to a graceful sentinel instead).

**Tuning guidance:**

- The most effective lever is **Chromium availability** — without a working Chromium, the proxy cannot generate Baxia tokens and requests will fail. Ensure `SF_QWEN_CHROME_PATH` points to a valid Chromium binary.
- If requests still get flagged, raise `SF_QWEN_MIN_REQUEST_GAP_MS` (e.g. 6000–8000).
- If empties persist, raise `SF_QWEN_EMPTY_RETRY_MAX` (default 3) or `SF_QWEN_EMPTY_RETRY_GAP_MS`; the post-exhaustion `SF_QWEN_EMPTY_COOLDOWN_MS` is a flat 10s.

## Authentication

All `/v1/*` endpoints (except `/v1/health`) require a valid API key. The health endpoint is public.

**Client gate** — the proxy checks API keys in this order:

1. `Authorization: Bearer <key>` header
2. `x-api-key: <key>` header

Keys are compared using constant-time comparison (`timingSafeEqual`).

**Key sources** (checked in order):

1. **`SF_QWEN_API_KEY`** env var — comma-separated list of valid keys (checked first)
2. **`api_keys` database table** — keys stored in the database (D8)

::: tip
Set `SF_QWEN_API_KEY` for the simplest setup. Multiple keys can be comma-separated (e.g. `SF_QWEN_API_KEY=key1,key2`).
:::

**Admin dashboard** — `/admin` has its own authentication gated by `SF_QWEN_ADMIN_KEY` (see [Admin dashboard](#admin-dashboard)).

## Configuration

All configuration is via environment variables (prefix `SF_QWEN_`).

### Server settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_HOST` | `127.0.0.1` | Server bind host (`0.0.0.0` in Docker) |
| `SF_QWEN_PORT` | `7790` | Server port |
| `SF_QWEN_DB` | `./data/qwen-proxy.db` | SQLite database file path |
| `SF_QWEN_LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Authentication & admin

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_API_KEY` | *(unset)* | Client API keys, comma-separated (required for `/v1/*` endpoints) |
| `SF_QWEN_ADMIN_KEY` | *(unset)* | Admin dashboard key. When unset, `/admin` returns **404** (dashboard invisible — D15) |

### Baxia (headless Chromium CDP)

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_USE_CHROME_BAXIA` | `true` | Use headless Chromium (Chrome CDP) for Baxia tokens |
| `SF_QWEN_CHROME_PATH` | *(unset)* | Path to Chrome/Chromium; unset → autodetect (`/usr/bin/chromium` in Docker) |
| `SF_QWEN_BAXIA_CACHE_TTL_MS` | `1500000` (25min) | Baxia token cache TTL |
| `SF_QWEN_BAXIA_VERSION` | `2.5.37` | Baxia `bx-v` version |
| `SF_QWEN_BAXIA_PRE_WARM` | `true` | Eagerly fetch the first token at startup (exit 1 on failure) |
| `SF_QWEN_BAXIA_FALLBACK` | `false` | Return last-known token on fetch failure |

### Timing & cooldown

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_RATE_LIMIT_COOLDOWN_MS` | `86400000` (24 h) | Rate-limit cooldown duration |
| `SF_QWEN_EMPTY_COOLDOWN_MS` | `10000` (10s) | Flat pool cooldown applied only AFTER inline empty-retries are exhausted |
| `SF_QWEN_EMPTY_RETRY_MAX` | `3` | Inline retries on an empty completion (Baxia CAPTCHA flag) before giving up. `0` disables (immediate cooldown) |
| `SF_QWEN_EMPTY_RETRY_GAP_MS` | `1000` (1s) | Sleep between inline empty-retry attempts |
| `SF_QWEN_MIN_REQUEST_GAP_MS` | `4000` (4 s) | Global look-human throttle (±50 % jitter) between requests. `0` disables |
| `SF_QWEN_MAX_CONCURRENCY` | `1` | Max in-flight chat.qwen.ai calls (1 = serialize, like the web chat — you can't send the next until the previous completes). Baxia flags the IP on concurrent upstream connections; raise only if you accept that risk |

### Model aliases

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_MODEL_ALIASES` | *(unset)* | JSON object mapping alias names to upstream model names (e.g. `{"gpt-4o":"qwen3-max"}`) |

## OpenAI API surface

The proxy exposes an OpenAI-compatible API on `/v1/*`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models (including aliases) |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |

**Authentication:** `Authorization: Bearer <key>` or `x-api-key: <key>`.

**Streaming:** `/v1/chat/completions` supports `stream: true` with Server-Sent Events (SSE). The response is a stream of `data: {...}` lines terminated by `data: [DONE]`.

### Function calling

OpenAI-style function calling (`tools`/`tool_choice`) is **supported** — qwen translates function definitions via prompt-engineering. `tools:[{type:"web_search"}]` and the `-search` model suffix also work for Qwen's built-in search.

### Thinking mode

`enable_thinking` is passed through to the upstream (default **off**). To enable thinking:

- Set `enable_thinking: true` in the request body, **or**
- Append `-thinking` to the model name (e.g. `qwen3-max-thinking`)

When thinking is enabled, the response includes `reasoning_content` in the chat completion (OpenAI) or `thinking` content blocks (Anthropic).

::: warning D14
Mid-stream sentinel errors from upstream terminate the stream with an error event followed by `data: [DONE]`. Clients should handle partial responses gracefully.
:::

## Anthropic API surface

The proxy exposes an Anthropic-compatible API:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Messages (streaming and non-streaming) |

**Model fallback:** Requests with `claude-*` model names are automatically translated to `qwen3-max` upstream.

**Authentication:** Same gate as OpenAI endpoints (`Authorization: Bearer <key>` or `x-api-key: <key>`).

**Thinking:** Pass `thinking:{type:"enabled"}` in the request body to enable thinking mode (translated to `enable_thinking:true` upstream). When thinking is enabled, the response includes `thinking` content blocks.

**Tools (function calling):** Anthropic-style tools are **not supported** and return **400**.

::: warning D7 — Thinking-block signatures (opt-in)
Anthropic thinking-block signatures are **empty strings** (`signature: ""`). Qwen does not provide verifiable signatures for thinking blocks. This only applies when thinking mode is enabled.
:::

## Admin dashboard

The admin dashboard is an optional read-only HTML interface for monitoring the proxy's internal state.

**URL:** `GET /admin`

**Gated by:** `SF_QWEN_ADMIN_KEY` — the dashboard key (separate from the client API key).

**Sections:**

- **Baxia cache-status panel** — shows the current state of the Baxia token cache:
  - State: `cached` (green badge) or `cold start`
  - Cached at: timestamp of last token fetch
  - Age: seconds since last cache
  - Cache TTL: configured TTL in seconds
  - Next refresh: ms until next background refresh, or `—`
  - Last spawn: duration of last Chromium spawn in seconds
  - Consecutive failures: count of failed token fetches
- **Guest mode note** — confirms the proxy is running in guest mode (no accounts)

**Auto-refresh:** The dashboard reloads every 10 seconds (full page reload).

**Authentication:** On first access, use `?key=<your-admin-key>` in the URL. This sets an `HttpOnly` `SameSite=Strict` cookie for subsequent requests. The key can also be passed via `Authorization: Bearer` or `x-api-key`.

::: warning D15
When `SF_QWEN_ADMIN_KEY` is **unset**, `/admin` returns **404** (not 401). The dashboard is completely invisible — a 401 would leak its existence. Set `SF_QWEN_ADMIN_KEY` to enable it.
:::

::: tip
The cookie does not include the `Secure` flag (intentional — the proxy runs on HTTP locally or behind a TLS-terminating reverse proxy). If you expose the dashboard over HTTPS via a reverse proxy, set `Secure` at the proxy level or use header-based authentication.
:::

## Known limitations

### D7 — Empty thinking-block signatures (Anthropic, opt-in)

Anthropic thinking blocks return `signature: ""`. Qwen does not provide verifiable signatures. SDKs that validate signatures will fail. This only applies when thinking mode is enabled via `thinking:{type:"enabled"}`.

### D14 — Mid-stream sentinel error handling

When the upstream Qwen API sends a mid-stream sentinel error, the proxy terminates the stream with an error event followed by `data: [DONE]`. Clients should handle partial responses and not assume a complete response on stream close.

### D15 — Admin dashboard 404 when unset

The admin dashboard returns 404 (not 401) when `SF_QWEN_ADMIN_KEY` is unset. This is intentional — 401 would reveal the dashboard's existence. Set the key to enable.

### No account failover

Guest mode uses a single virtual session — there is no account pool or round-robin failover. When an empty completion is detected (Baxia CAPTCHA flag), the proxy retries the same request inline up to `SF_QWEN_EMPTY_RETRY_MAX` (default 3) times; on exhaustion it applies a flat `SF_QWEN_EMPTY_COOLDOWN_MS` (10s) pool cooldown + returns 429 (a stream that already committed HTTP 200 degrades to a graceful sentinel). There is no account to switch to; the proxy must wait for the cooldown to clear.

### Chromium must be available

The proxy requires a working Chromium binary for Baxia token generation. If Chromium is not available (e.g. `SF_QWEN_USE_CHROME_BAXIA=false` with no alternative token source, or the Chromium binary is missing), the proxy cannot generate Baxia tokens and requests to chat.qwen.ai will fail. In Docker, Chromium is bundled in the image; for native installs, ensure `chromium` is on `PATH` or set `SF_QWEN_CHROME_PATH`.
