# qwen-proxy Docker

The `@pi-stef/qwen-proxy` service is published as a multi-arch Docker image to the GitHub Container Registry.

## Quick start

```bash
cd packages/qwen-proxy/docker
SF_QWEN_API_KEY=your-secret-key docker compose up -d
```

This pulls `ghcr.io/sfiorini/pi-stef/qwen-proxy:latest` and starts the service.

Check it's running:

```bash
curl http://127.0.0.1:7790/v1/health
# {"status":"ok"}
```

## Architecture

```
SDK client → proxy → chat.qwen.ai
```

The proxy runs in **guest mode** — no Qwen account or login required. It talks directly to [chat.qwen.ai](https://chat.qwen.ai), using headless Chromium (Chrome CDP) to generate Baxia anti-bot tokens. Tokens are cached for 25 minutes with background refresh.

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

## Chromium requirements

The Docker image bundles Chromium for Baxia token generation. The compose file and Dockerfile are tuned for this:

- **`shm_size: 2g` + `mem_limit: 2g`** — Chromium needs >64 MB `/dev/shm`; the 2 GB limits cover Chromium (~250 MB) + Node + SQLite with headroom.
- **`--no-sandbox`** — required under Docker's default seccomp profile because a non-root user (uid 1000) cannot use the user-namespace sandbox. Mitigated by: non-root uid 1000, localhost-only CDP, ephemeral browser dir, single trusted URL (chat.qwen.ai), and short-lived Chrome processes. The flag is already set in `BaxiaTokenManager.startChrome`.
- **`fonts-liberation` + `fonts-noto-color-emoji`** — CJK and emoji rendering for Baxia page content.
- **`XDG_CACHE_HOME=/home/node/.cache`** — writable fontconfig cache directory (pre-created and chowned to uid 1000 in the Dockerfile).

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
- **Runtime stage** — `node:22-bookworm-slim` with Chromium, fonts, and `curl`; non-root uid 1000; `/data` and `/home/node/.cache` pre-created and chowned

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
    # Chromium needs >64MB /dev/shm; --disable-dev-shm-usage is belt-and-suspenders.
    # mem_limit covers Chromium ~250MB + Node + SQLite (~2GB total headroom).
    shm_size: 2g
    mem_limit: 2g
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
      # Baxia (headless Chromium CDP) — enabled by default in the Docker image:
      - SF_QWEN_CHROME_PATH=/usr/bin/chromium
      # Optional — admin dashboard (unset → /admin returns 404):
      # - SF_QWEN_ADMIN_KEY=${SF_QWEN_ADMIN_KEY}
      # Optional — Baxia cache TTL (default 25 min):
      # - SF_QWEN_BAXIA_CACHE_TTL_MS=1500000
      # Optional — eagerly warm the first Baxia token at startup (default true):
      # - SF_QWEN_BAXIA_PRE_WARM=true
    restart: unless-stopped
    # healthcheck lives in the Dockerfile

volumes:
  qwen-data:
```

The compose file defaults to `127.0.0.1` only. See [Port binding](#port-binding-same-machine-vs-remote-server) above to expose the service to the LAN.

## Configuration

All configuration is via environment variables (prefix `SF_QWEN_`). Set them in the `environment:` section of `docker-compose.yml` or your shell:

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
| `SF_QWEN_BAXIA_VERSION` | `2.5.37` | Baxia `bx-v` version |
| `SF_QWEN_BAXIA_PRE_WARM` | `true` | Eagerly fetch the first token at startup (exit 1 on failure) |
| `SF_QWEN_BAXIA_FALLBACK` | `false` | Return last-known token on fetch failure |

## Volumes

One named volume persists data across container restarts:

| Volume | Mount | Contents |
|--------|-------|----------|
| `qwen-data` | `/data` | SQLite database (`qwen-proxy.db`) |

qwen-proxy does **not** use a config/token volume — the API key is set directly via `SF_QWEN_API_KEY` (no auto-generated token).

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
| Chromium fails to start | Check `docker compose logs`; ensure `shm_size: 2g` is set and `/home/node/.cache` is writable |

## Native (non-Docker) alternative

The proxy can also run natively with `pnpm serve`:

```bash
pnpm --filter @pi-stef/qwen-proxy serve
```

See the [service page](./qwen-proxy#quick-start) for native configuration and setup.
