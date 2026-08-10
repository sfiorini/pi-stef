# qwen-proxy

Multi-account proxy forwarding to the [qwen.aikit.club](https://qwen.aikit.club) OpenAI gateway with OpenAI + Anthropic compatibility.

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

qwen-proxy is an always-on reverse proxy that sits between your AI client (pi, OpenAI SDK, Anthropic SDK, or any HTTP client) and the upstream Qwen model API. It provides:

- **Multi-account pool** — round-robin across Qwen accounts with automatic failover
- **JWT-only token refresh** — scheduled JWT refresh per account (chat.qwen.ai login); on-demand re-login on 401
- **Rate-limit cooldown** — automatic disable on 429 with configurable cooldown, periodic re-enable sweep
- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`, `/v1/images/*`, `/v1/videos/*`
- **Anthropic-compatible API** — `/v1/messages` with `claude-*` model fallback to `qwen3-max`
- **Admin dashboard** — read-only HTML dashboard at `/admin` (optional)

## Architecture

### Request flow

```
SDK client ──Bearer SF_QWEN_API_KEY──▶ our proxy (7790)
                                        │ login: POST chat.qwen.ai/api/v1/auths/signin → JWT
                                        │ forward: Bearer JWT → qwen.aikit.club/v1/*
                                        ▼ chat.qwen.ai (via the Worker's internal anti-bot handling)
```

The proxy logs into **chat.qwen.ai** to obtain a JWT, then forwards all API requests to **[qwen.aikit.club](https://qwen.aikit.club)** — a Cloudflare Worker that handles the Alibaba Baxia anti-bot internally. The proxy does **not** beat Baxia itself; it relies on the upstream gateway.

### Account pool

The proxy manages a pool of Qwen accounts. Each account has an `email`, `password`, and `ord` (ordinal for round-robin ordering). On startup the proxy reconciles the configured accounts against the database, logs in to each, and begins serving requests.

- **Round-robin** — requests are distributed by `ord`; the active account rotates on each request
- **Auto-disable** — if an account receives a 429 from upstream, it is disabled for `SF_QWEN_RATE_LIMIT_COOLDOWN_MS` (default 24 hours)
- **Re-enable sweep** — every `SF_QWEN_REENABLE_INTERVAL_MS` (default 1 minute) the proxy checks disabled accounts and re-enables those past their cooldown

Database tables: `accounts`, `tokens`, `rate_limits`, `login_failures`, `video_jobs` (unused, retained for migration compatibility).

### Token refresh

Each account maintains a JWT refreshed on a scheduled interval:

- **JWT** — refreshed every `SF_QWEN_JWT_REFRESH_MS` (default 6 hours); re-login if within `SF_QWEN_REFRESH_THRESHOLD_MS` of expiry or on-demand when a 401 is received from upstream

### Rate-limit cooldown

`setRateLimit` performs a full upsert (not a merge) — every call replaces the entire rate-limit row for that account. The default cooldown is 24 hours.

::: warning D13
`setRateLimit` is a full upsert, not a merge. Any partial rate-limit state from a prior call is replaced.
:::

## Upstream gateway

The proxy forwards API requests to **[qwen.aikit.club](https://qwen.aikit.club)**, an OpenAI-compatible gateway to chat.qwen.ai. The gateway is a community-maintained Cloudflare Worker.

| Resource | URL |
|----------|-----|
| Gateway API docs | [qwen-api.readme.io](https://qwen-api.readme.io) |
| Worker source | [encryptarun/qwen-api](https://github.com/encryptarun/qwen-api) |

::: warning Third-party dependency
qwen-proxy's upstream reliability is coupled to the [qwen.aikit.club](https://qwen.aikit.club) Cloudflare Worker. If you need uptime control, you can self-host [encryptarun/qwen-api](https://github.com/encryptarun/qwen-api) and point `SF_QWEN_API_URL` at your own deployment.
:::

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

### Upstream URLs

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_AUTH_URL` | `https://chat.qwen.ai` | Login endpoint (JWT acquisition only) |
| `SF_QWEN_API_URL` | `https://qwen.aikit.club` | Forward gateway for all API requests (`/v1/*`) |

`SF_QWEN_AUTH_URL` is used exclusively for login (`/api/v1/auths/signin`). All other requests are forwarded to `SF_QWEN_API_URL`. To use a self-hosted gateway, set `SF_QWEN_API_URL` to your own [encryptarun/qwen-api](https://github.com/encryptarun/qwen-api) deployment.

### Account configuration

Accounts can be configured via one of three modes (see [Account modes](#account-modes) below):

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_ACCOUNTS` | *(unset)* | JSON array of account objects |
| `SF_QWEN_ACCOUNTS_FILE` | *(unset)* | Path to a JSON file containing accounts |
| `SF_QWEN_ACCOUNT_N_*` | *(unset)* | Numbered environment variables (see below) |

### Model aliases

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_MODEL_ALIASES` | *(unset)* | JSON object mapping alias names to upstream model names (e.g. `{"gpt-4o":"qwen3-max"}`) |

### Timing & cooldown

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_JWT_REFRESH_MS` | `21600000` (6 h) | Scheduled JWT refresh interval |
| `SF_QWEN_REFRESH_THRESHOLD_MS` | `21600000` (6 h) | Token refresh threshold (re-login if within this of expiry) |
| `SF_QWEN_LOGIN_TIMEOUT_MS` | `10000` (10 s) | Login request timeout |
| `SF_QWEN_STAGGER_MS` | `5000` (5 s) | Random stagger for startup logins (avoids thundering herd) |
| `SF_QWEN_RATE_LIMIT_COOLDOWN_MS` | `86400000` (24 h) | Rate-limit cooldown duration |
| `SF_QWEN_REENABLE_INTERVAL_MS` | `60000` (1 min) | Re-enable sweep interval |

### Account modes

Accounts are configured via one of three mutually exclusive modes. The proxy checks them in order: JSON → file → numbered env vars.

#### Mode 1: `SF_QWEN_ACCOUNTS` (JSON inline)

```bash
SF_QWEN_ACCOUNTS='[{"id":1,"email":"user@example.com","password":"pass","ord":1}]'
```

#### Mode 2: `SF_QWEN_ACCOUNTS_FILE` (file path)

```bash
SF_QWEN_ACCOUNTS_FILE=/path/to/accounts.json
```

The file contains the same JSON array format as Mode 1.

#### Mode 3: Numbered environment variables

```bash
SF_QWEN_ACCOUNT_1_EMAIL=user@example.com
SF_QWEN_ACCOUNT_1_PASSWORD=pass
SF_QWEN_ACCOUNT_1_ID=1        # optional (defaults to the number)
SF_QWEN_ACCOUNT_1_ORD=1       # optional (defaults to ID)
```

Repeat for each account, incrementing the number (`SF_QWEN_ACCOUNT_2_EMAIL`, etc.). Only `EMAIL` and `PASSWORD` are required.

### Model aliases

Map friendly names to upstream Qwen model identifiers:

```bash
SF_QWEN_MODEL_ALIASES='{"gpt-4o":"qwen3-max","claude-3-opus":"qwen3-max"}'
```

This allows clients to request `gpt-4o` or `claude-3-opus` and have the proxy translate to the configured upstream model.

## OpenAI API surface

The proxy exposes an OpenAI-compatible API on `/v1/*`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models (including aliases) |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/images/edits` | Image editing |
| `POST` | `/v1/videos/generations` | Video generation (synchronous — blocks until URL returns) |
| `POST` | `/v1/videos/edits` | Video editing (**404** — not yet supported) |

**Authentication:** `Authorization: Bearer <key>` or `x-api-key: <key>`.

**Streaming:** `/v1/chat/completions` supports `stream: true` with Server-Sent Events (SSE). The response is a stream of `data: {...}` lines terminated by `data: [DONE]`.

### Video generation (synchronous)

Video generation is **synchronous**: `POST /v1/videos/generations` blocks until the upstream returns a video URL (200 response). There is no job-polling endpoint.

```
POST /v1/videos/generations
{ "prompt": "a cat playing piano", "size": "1280x720" }

→ 200 { "created": 1234567890, "data": [{ "url": "https://..." }] }
```

::: warning Wall-time budget
Synchronous video generation can take 300+ seconds. Ensure your reverse proxy and Cloudflare settings allow at least a 300-second wall-time budget (e.g. `proxy_read_timeout 300s` in nginx; CF Enterprise for longer limits).
:::

### Function calling

OpenAI-style function calling (`tools:[{type:"function"}]` or `tool_choice`) is **not supported** and returns **400**. To use Qwen's built-in search, pass `tools:[{type:"web_search"}]` or append `-search` to the model name (e.g. `qwen3-max-search`).

### Thinking mode

`enable_thinking` is passed through to the upstream gateway (default **off**). To enable thinking:

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
- **Accounts** — pool state, email, ordinal, active/disabled status
- **Pool snapshot** — current active account (or "Pool exhausted" warning)
- **Tokens** — bearer status, expiry, last refresh time per account
- **Rate limits** — 429 timestamps, retry-after, re-enable times
- **Login failures** — recent failures with reason and status code
- **Usage** — derived per-account metrics (login failures in 24h, last token refresh)

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

### D12 — Reconcile disables all but first account on startup

On startup, the reconcile process may disable all accounts except the first one if there are conflicts in account configuration. Ensure each account has a unique `id` and `ord`.

### D13 — `setRateLimit` is a full upsert

The rate-limit store performs a full row replacement on every 429 response, not a field-level merge. Any partial state from a prior call is replaced.

### D14 — Mid-stream sentinel error handling

When the upstream Qwen API sends a mid-stream sentinel error, the proxy terminates the stream with an error event followed by `data: [DONE]`. Clients should handle partial responses and not assume a complete response on stream close.

### D15 — Admin dashboard 404 when unset

The admin dashboard returns 404 (not 401) when `SF_QWEN_ADMIN_KEY` is unset. This is intentional — 401 would reveal the dashboard's existence. Set the key to enable.

### D18 — qwen.aikit.club repoint

The proxy forwards to the third-party [qwen.aikit.club](https://qwen.aikit.club) OpenAI gateway (not directly to chat.qwen.ai). Video generation is synchronous (POST blocks until URL; no job polling). OpenAI function-calling (`tools:[{type:"function"}]` / `tool_choice`) is rejected with 400 — use `-search` suffix or `tools:[{type:"web_search"}]`. The gateway handles anti-bot internally; the proxy authenticates with JWT only. `<details>` junk from upstream is stripped at the adapter boundary. Upstream reliability is coupled to the third-party CF Worker; self-host via `SF_QWEN_API_URL` for uptime control.
