# @pi-stef/qwen-proxy

Multi-account proxy for the Qwen AI API with OpenAI + Anthropic compatibility. Backed by SQLite; serves an HTTP API that is wire-compatible with OpenAI and Anthropic SDKs.

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
- **Token refresh** — scheduled ssxmod cookie and JWT refresh per account
- **Rate-limit cooldown** — automatic disable on rate-limit, periodic re-enable sweep
- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`, `/v1/images/*`, `/v1/videos/*`
- **Anthropic-compatible API** — `/v1/messages` with `claude-*` model fallback to `qwen3-max`
- **Admin dashboard** — read-only HTML dashboard at `/admin` (optional, gated by `SF_QWEN_ADMIN_KEY`)
- **Docker** — multi-arch image (`linux/amd64`, `linux/arm64`) on GHCR, non-root uid 1000

---

## Documentation

- [Service docs](https://sfiorini.github.io/pi-stef/packages/qwen-proxy) — configuration, API surface, architecture, known limitations
- [Docker guide](https://sfiorini.github.io/pi-stef/packages/qwen-proxy-docker) — deployment, volumes, reverse-proxy setup

---

## License

[MIT](../../LICENSE)
