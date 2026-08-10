# qwen-proxy Docker

The `@pi-stef/qwen-proxy` service is published as a multi-arch Docker image to the GitHub Container Registry (GHCR).

## Quick start

```bash
cd packages/qwen-proxy/docker
SF_QWEN_API_KEY=your-secret-key docker compose up -d
```

This pulls `ghcr.io/sfiorini/pi-stef/qwen-proxy:latest` and starts the proxy on port 7790.

Check it's running:

```bash
curl http://127.0.0.1:7790/v1/health
# {"status":"ok"}
```

## Port binding: same machine vs remote server

The default compose file binds to `127.0.0.1:7790` — **localhost only**. This is the right choice when the pi client and the qwen-proxy service run on the same host. The service is invisible to the LAN.

The host bind address and host port are configurable via two compose-substitution env vars (the container always listens on 7790 internally), so you never need to edit the compose file or fight override-merge semantics:

| Variable | Default | Use |
|----------|---------|-----|
| `SF_QWEN_HOST_PORT` | `7790` | Host port to publish (change it if 7790 is taken). |
| `SF_QWEN_BIND` | `127.0.0.1` | Host bind address. Set `0.0.0.0` for all interfaces (LAN). |

```bash
# Same machine (default):
docker compose up -d

# 7790 is taken → publish on another host port:
SF_QWEN_HOST_PORT=7791 docker compose up -d

# Remote server (LAN-accessible) → bind all interfaces:
SF_QWEN_BIND=0.0.0.0 docker compose up -d
```

With `SF_QWEN_BIND=0.0.0.0` the service listens on all interfaces. The API key still protects every API endpoint, so this is safe on a trusted LAN. For untrusted networks, keep the default `127.0.0.1` and use an SSH tunnel instead:

```bash
ssh -L 7790:127.0.0.1:7790 your-server
# Then access the service at http://127.0.0.1:7790
```

## Image

| Registry | Image |
|----------|-------|
| GHCR | `ghcr.io/sfiorini/pi-stef/qwen-proxy` |

**Tags:**

- `latest` — most recent release
- `X.Y.Z` — pinned release (e.g. `0.1.0`)

**Platforms:** `linux/amd64`, `linux/arm64` (Intel Macs / Linux servers + Apple Silicon).

```bash
# Pull a specific version
docker pull ghcr.io/sfiorini/pi-stef/qwen-proxy:0.1.0
```

The image is built from the repo source on every `@pi-stef/qwen-proxy@X.Y.Z` tag push (see `.github/workflows/docker-qwen-proxy.yml`), so it always matches the released npm package.

## Non-root security (uid 1000)

The container runs as **uid 1000** (non-root) for security (D16). The `/data` directory is pre-created and chowned to `1000:1000` in the Dockerfile so the SQLite database can be written on first boot.

::: warning D16
The container runs as **non-root uid 1000** (not root). The `/data` directory is chowned to `1000:1000` in the Dockerfile to ensure the SQLite database can be created on first boot.
:::

Verify non-root execution:

```bash
docker inspect qwen-proxy:dev --format '{{.Config.User}}'
# 1000
```

To override the user (e.g. for debugging), pass `--user`:

```bash
docker run --rm --user root -it qwen-proxy:dev /bin/bash
```

## Build from source (local dev)

To build the image locally instead of pulling from the registry:

```bash
cd packages/qwen-proxy/docker
# Uncomment the `build:` block in docker-compose.yml, then:
docker compose up --build
```

Or build directly with `docker build`:

```bash
docker build -f packages/qwen-proxy/docker/Dockerfile -t qwen-proxy:dev .
```

The Dockerfile is a multi-stage source build:

- **Build stage** — installs `python3`/`make`/`g++` to compile `better-sqlite3` native bindings; runs `pnpm install --prod --frozen-lockfile`
- **Runtime stage** — `node:22-slim` with `curl` for healthchecks; non-root uid 1000; `/data` pre-created and chowned

## docker-compose.yml

```yaml
services:
  qwen-proxy:
    # Pull the published image from GHCR (default):
    image: ghcr.io/sfiorini/pi-stef/qwen-proxy:latest
    # To build from local source instead, comment out `image:` above and run:
    #   docker compose up --build
    # build:
    #   context: ../../..
    #   dockerfile: packages/qwen-proxy/docker/Dockerfile
    ports:
      - "${SF_QWEN_BIND:-127.0.0.1}:${SF_QWEN_HOST_PORT:-7790}:7790"
    volumes:
      - qwen-data:/data
    environment:
      - SF_QWEN_DB=/data/qwen-proxy.db
      - SF_QWEN_HOST=0.0.0.0
      - SF_QWEN_PORT=7790
      # Required — operator sets directly (no auto-generated token):
      - SF_QWEN_API_KEY=${SF_QWEN_API_KEY:?must be set}
      # Optional — admin dashboard (unset → /admin returns 404):
      # - SF_QWEN_ADMIN_KEY=${SF_QWEN_ADMIN_KEY}
      # Accounts (one of the three modes — see docs):
      # - SF_QWEN_ACCOUNTS=${SF_QWEN_ACCOUNTS}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:7790/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  qwen-data:
```

The compose file defaults to `127.0.0.1` only. See [Port binding](#port-binding-same-machine-vs-remote-server) above to expose the service to the LAN.

## Architecture

```
SDK client → our proxy (7790) → qwen.aikit.club → chat.qwen.ai
```

The proxy logs into **chat.qwen.ai** to obtain a JWT, then forwards all API requests to **[qwen.aikit.club](https://qwen.aikit.club)** — a community Cloudflare Worker that handles the Alibaba Baxia anti-bot internally. See the [Upstream gateway](./qwen-proxy#upstream-gateway) section in the service docs for links and the self-host option.

::: warning Third-party dependency
qwen-proxy's upstream reliability is coupled to the [qwen.aikit.club](https://qwen.aikit.club) Cloudflare Worker. To control uptime, self-host [encryptarun/qwen-api](https://github.com/encryptarun/qwen-api) and set `SF_QWEN_API_URL` to your deployment.
:::

## Configuration

All configuration is via environment variables (prefix `SF_QWEN_`). Set them in the `environment:` section of `docker-compose.yml` or your shell:

| Variable | Default (Docker) | Description |
|----------|------------------|-------------|
| `SF_QWEN_HOST` | `0.0.0.0` | Server bind host |
| `SF_QWEN_PORT` | `7790` | Server port |
| `SF_QWEN_DB` | `/data/qwen-proxy.db` | SQLite database path (D17 — single source of truth) |
| `SF_QWEN_API_KEY` | **required** | Client API keys, comma-separated |
| `SF_QWEN_ADMIN_KEY` | _(unset)_ | Admin dashboard key; unset → `/admin` returns 404 (D15) |
| `SF_QWEN_API_URL` | `https://qwen.aikit.club` | Forward gateway for API requests (`/v1/*`) |
| `SF_QWEN_AUTH_URL` | `https://chat.qwen.ai` | Login endpoint (JWT acquisition only) |

::: warning D17
There is **no `SF_QWEN_DATA_DIR`**. The database path `SF_QWEN_DB=/data/qwen-proxy.db` is the single source of truth. The proxy derives the data directory from `dirname(dbPath)`.
:::

**Account modes** (one of three — see [service docs](./qwen-proxy#account-modes)):

| Mode | Variable | Description |
|------|----------|-------------|
| JSON inline | `SF_QWEN_ACCOUNTS` | JSON array of account objects |
| File path | `SF_QWEN_ACCOUNTS_FILE` | Path to a JSON file containing accounts |
| Numbered env | `SF_QWEN_ACCOUNT_N_*` | `SF_QWEN_ACCOUNT_1_EMAIL`, etc. |

See the [service configuration](./qwen-proxy#configuration) for the full reference.

## Volumes

One named volume persists data across container restarts:

| Volume | Mount | Contents |
|--------|-------|----------|
| `qwen-data` | `/data` | SQLite database (`qwen-proxy.db`) |

qwen-proxy does **not** use a config/token volume — the API key is set directly via `SF_QWEN_API_KEY` (no auto-generated token).

## Video generation (synchronous)

Video generation is synchronous: `POST /v1/videos/generations` blocks until the upstream returns a URL (200 response). Ensure your reverse proxy and Cloudflare settings allow at least a **300-second** wall-time budget (e.g. `proxy_read_timeout 300s` in nginx).

## Healthcheck

The container includes a built-in healthcheck hitting `/v1/health` every 30s:

```bash
docker compose ps   # STATUS column shows "healthy"
```

## Reverse-proxy notes

By default the proxy binds to `127.0.0.1:7790` (localhost only). If you need to expose it over the internet or to other machines, use a TLS-terminating reverse proxy (e.g. nginx, Caddy, Traefik):

### Proxy configuration

1. **Forward authentication headers** — the proxy requires `Authorization: Bearer <key>` or `x-api-key: <key>` on every `/v1/*` request. Configure your reverse proxy to pass these headers through:

   ```nginx
   # nginx example
   location / {
       proxy_pass http://127.0.0.1:7790;
       proxy_set_header Authorization $http_authorization;
       proxy_set_header x-api-key $http_x_api_key;
   }
   ```

2. **Disable response buffering for SSE** — streaming endpoints (`/v1/chat/completions` with `stream: true`, `/v1/messages` with `stream: true`) use Server-Sent Events. Your reverse proxy **must** disable response buffering or SSE chunks will be delayed and batched:

   ```nginx
   # nginx — disable buffering for SSE
   location /v1/chat/completions {
       proxy_pass http://127.0.0.1:7790;
       proxy_buffering off;
       proxy_cache off;
   }
   location /v1/messages {
       proxy_pass http://127.0.0.1:7790;
       proxy_buffering off;
       proxy_cache off;
   }
   ```

   For Caddy and Traefik, buffering is disabled by default for proxied responses.

3. **Protect `/admin`** — the admin dashboard key travels in the URL query string (`?key=...`) on first access. If the proxy is internet-facing, protect `/admin` at the proxy level with IP allowlisting, proxy-level authentication, or omit the `/admin` location entirely.

## GHCR visibility

The first push creates the package under the `sfiorini` namespace on GHCR. By default the image inherits the repository's visibility (private for a private repo). To allow unauthenticated pulls, set the package to **public** in the GitHub UI:

1. Go to the [repository packages page](https://github.com/sfiorini/pi-stef/pkgs/container/pi-stef%2Fqwen-proxy)
2. Click **Package settings** → **Change visibility** → **Public**

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | API key mismatch — check `SF_QWEN_API_KEY` matches what the client sends |
| Port already in use | Change `SF_QWEN_PORT` and the compose port mapping (`7790:7790`) |
| `better-sqlite3` build fails (building from source) | Use the prebuilt GHCR image; building from source needs `python3`, `make`, `g++` |
| Can't reach service from another machine | Port bound to `127.0.0.1` only — change to `"7790:7790"` in docker-compose.yml (see [Port binding](#port-binding-same-machine-vs-remote-server) above) |
| Healthcheck never goes healthy | Check `docker compose logs qwen-proxy`; ensure the `qwen-data` volume is writable by uid 1000 |
| Image pull fails (private package) | Make the GHCR package public (see [GHCR visibility](#ghcr-visibility) above) |
| SSE streaming is slow or buffered | Disable response buffering in your reverse proxy (see [Reverse-proxy notes](#reverse-proxy-notes)) |
| `/admin` returns 404 | Set `SF_QWEN_ADMIN_KEY` — the dashboard is invisible when the key is unset (D15) |

## Native (non-Docker) alternative

The proxy can also run natively with `pnpm serve`:

```bash
pnpm --filter @pi-stef/qwen-proxy serve
```

See the [service page](./qwen-proxy#quick-start) for native configuration and setup.
