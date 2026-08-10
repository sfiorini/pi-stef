# @pi-stef/qwen-proxy

Multi-account proxy forwarding to the [qwen.aikit.club](https://qwen.aikit.club) OpenAI gateway with OpenAI + Anthropic compatibility. Backed by SQLite; serves an HTTP API that is wire-compatible with OpenAI and Anthropic SDKs.

---

## Quick start

### Docker (recommended)

```bash
cd packages/qwen-proxy/docker
SF_QWEN_API_KEY=your-secret-key docker compose up -d
```

Pulls `ghcr.io/sfiorini/pi-stef/qwen-proxy:latest` and starts the proxy on port 7790. See the [Docker guide](docker/README.md#port-binding-same-machine-vs-remote-server) for details, volumes, image tags, and reverse-proxy setup.

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

- **Multi-account pool** — round-robin across Qwen accounts with automatic failover on 429
- **JWT-only token refresh** — scheduled JWT refresh per account (chat.qwen.ai login); on-demand re-login on 401
- **Synchronous video generation** — `POST /v1/videos/generations` blocks until URL returns (≥300s wall-time budget)
- **Third-party gateway** — forwards to [qwen.aikit.club](https://qwen.aikit.club), a community Cloudflare Worker that handles Baxia anti-bot internally ([docs](https://qwen-api.readme.io) · [source](https://github.com/encryptarun/qwen-api)); does NOT beat Baxia itself; self-host via `SF_QWEN_API_URL`
- **Rate-limit cooldown** — automatic disable on rate-limit, periodic re-enable sweep
- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`, `/v1/images/*`, `/v1/videos/*`
- **Anthropic-compatible API** — `/v1/messages` with `claude-*` model fallback to `qwen3-max`
- **Admin dashboard** — read-only HTML dashboard at `/admin` (optional, gated by `SF_QWEN_ADMIN_KEY`)
- **Docker** — multi-arch image (`linux/amd64`, `linux/arm64`) on GHCR, non-root uid 1000

---

## Configuration

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_API_URL` | `https://qwen.aikit.club` | Forward gateway for API requests |
| `SF_QWEN_AUTH_URL` | `https://chat.qwen.ai` | Login endpoint (JWT acquisition only) |
| `SF_QWEN_API_KEY` | *(required)* | Client API keys, comma-separated |
| `SF_QWEN_ADMIN_KEY` | *(unset)* | Admin dashboard key |
| `SF_QWEN_JWT_REFRESH_MS` | `21600000` (6 h) | Scheduled JWT refresh interval |

See the [full configuration reference](https://sfiorini.github.io/pi-stef/packages/qwen-proxy#configuration) for all options.

---

## Documentation

- [Service docs](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) — configuration, API surface, architecture, known limitations
- [Docker guide](https://sfiorini.github.io/pi-stef/packages/qwen-proxy-docker) — deployment, volumes, reverse-proxy setup

---

## License

[MIT](../../LICENSE)
