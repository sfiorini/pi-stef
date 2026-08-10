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

The Dockerfile is a multi-stage source build. The build stage installs `python3`/`make`/`g++` to compile `better-sqlite3` native bindings; the runtime stage is slim and ships only the compiled app plus `curl` for healthchecks.

## docker-compose.yml

```yaml
services:
  qwen-proxy:
    image: ghcr.io/sfiorini/pi-stef/qwen-proxy:latest
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
      - SF_QWEN_API_KEY=${SF_QWEN_API_KEY:?must be set}
      # - SF_QWEN_ADMIN_KEY=${SF_QWEN_ADMIN_KEY}
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

## Configuration

All configuration is via environment variables (prefix `SF_QWEN_`), set automatically by `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_QWEN_HOST` | `0.0.0.0` (container) | Server bind host |
| `SF_QWEN_PORT` | `7790` | Server port |
| `SF_QWEN_DB` | `/data/qwen-proxy.db` | SQLite database path (D17 — single source of truth) |
| `SF_QWEN_API_KEY` | **required** | Comma-separated API keys for client authentication |
| `SF_QWEN_ADMIN_KEY` | _(unset)_ | Admin dashboard key; unset → `/admin` returns 404 (D15) |

**Account modes** (one of three — see [service README](../README.md)):

| Mode | Variable | Description |
|------|----------|-------------|
| JSON inline | `SF_QWEN_ACCOUNTS` | JSON array of account objects |
| File path | `SF_QWEN_ACCOUNTS_FILE` | Path to a JSON file containing accounts |
| Numbered env | `SF_QWEN_ACCOUNT_N_*` | `SF_QWEN_ACCOUNT_1_EMAIL`, etc. |

See the [service README](../README.md) for the full configuration reference.

## Volumes

One named volume persists data across container restarts:

| Volume | Mount | Contents |
|--------|-------|----------|
| `qwen-data` | `/data` | SQLite database (`qwen-proxy.db`) |

Unlike `finance-api`, qwen-proxy does **not** use a config/token volume — the API key is set directly via `SF_QWEN_API_KEY` (no auto-generated token).

## Healthcheck

The container includes a built-in healthcheck hitting `/v1/health` every 30s:

```bash
docker compose ps   # STATUS column shows "healthy"
```

## GHCR visibility

The first push creates the package under the `sfiorini` namespace on GHCR. By default the image inherits the repository's visibility (private for a private repo). To allow unauthenticated pulls, set the package to **public** in GitHub → Packages → `pi-stef/qwen-proxy` → Package settings.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | API key mismatch — check `SF_QWEN_API_KEY` matches what the client sends |
| Port already in use | Change `SF_QWEN_PORT` and the compose port mapping |
| `better-sqlite3` build fails | Use the prebuilt registry image; building from source requires the build stage's toolchain |
| Can't reach service from another machine | Port bound to `127.0.0.1` only — change to `"7790:7790"` in docker-compose.yml (see [Port binding](#port-binding-same-machine-vs-remote-server) above) |
| Healthcheck never goes healthy | Check `docker compose logs qwen-proxy`; ensure the `/data` volume is writable by uid 1000 |

## Validation (pre-release)

Before publishing, run these manual checks from the repo root:

```bash
# 1. Build succeeds from repo root:
docker build -f packages/qwen-proxy/docker/Dockerfile -t qwen-proxy:dev .

# 2. Container starts and health endpoint responds:
docker run --rm -d -e SF_QWEN_API_KEY=test -p 7790:7790 --name qwen-validate qwen-proxy:dev
curl -fsS http://127.0.0.1:7790/v1/health   # → {"status":"ok"}

# 3. Process runs as non-root uid 1000 (D16):
docker exec qwen-validate id -u              # → 1000
docker inspect qwen-proxy:dev --format '{{.Config.User}}'  # → 1000

# 4. /data exists and is owned by uid 1000:
docker exec qwen-validate ls -ld /data       # → ... 1000 1000 ... /data

# 5. Clean up:
docker stop qwen-validate
```

## Native alternative

To run without Docker, use `pnpm serve` directly:

```bash
pnpm --filter @pi-stef/qwen-proxy serve
```

See the [service README](../README.md) for native configuration and setup.
