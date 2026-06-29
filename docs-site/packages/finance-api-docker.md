# finance-api Docker

The `@pi-stef/finance-api` service is published as a multi-arch Docker image to the GitHub Container Registry (GHCR).

## Quick start

```bash
cd packages/finance-api/docker
docker compose up -d
```

Pulls `ghcr.io/sfiorini/pi-stef/finance-api:latest` and serves the API at `http://127.0.0.1:7780`.

Check it's running:

```bash
curl http://127.0.0.1:7780/v1/health
# {"ok":true,"data":{"status":"ok","uptimeS":0}}
```

## Image

| Registry | Image |
|----------|-------|
| GHCR | `ghcr.io/sfiorini/pi-stef/finance-api` |

**Tags:**

- `latest` — most recent release
- `X.Y.Z` — pinned release (e.g. `0.1.2`)

**Platforms:** `linux/amd64`, `linux/arm64` (Intel Macs / Linux + Apple Silicon).

```bash
# Pull a specific version
docker pull ghcr.io/sfiorini/pi-stef/finance-api:0.1.2
```

The image is built from source on every `@pi-stef/finance-api@X.Y.Z` tag push (see `.github/workflows/docker.yml`), so it always matches the released npm package.

## Build from source (local dev)

To build locally instead of pulling from GHCR:

```bash
cd packages/finance-api/docker
# Uncomment the `build:` block in docker-compose.yml, then:
docker compose up --build
```

Or directly with `docker build`:

```bash
docker build -f packages/finance-api/docker/Dockerfile -t finance-api:dev .
```

The Dockerfile uses a multi-stage source build. The build stage installs `python3`/`make`/`g++` to compile `better-sqlite3` native bindings for SQLite support; the runtime stage is slim and ships only the compiled app plus `curl` for healthchecks.

## docker-compose.yml

```yaml
services:
  finance-api:
    image: ghcr.io/sfiorini/pi-stef/finance-api:latest
    # build: .  # uncomment to build from source instead of pulling
    ports:
      - "127.0.0.1:7780:7780"
    environment:
      SF_FINANCE_HOST: "0.0.0.0"
      SF_FINANCE_PORT: "7780"
      SF_FINANCE_DB: "/data/finance.db"
    volumes:
      - finance-data:/data
      - finance-config:/root/.pi/sf/finance
    restart: unless-stopped

volumes:
  finance-data:
  finance-config:
```

The compose file binds to `127.0.0.1` only — the service is not exposed to the LAN.

## Configuration

All configuration via environment variables (prefix `SF_FINANCE_`):

| Variable | Default (Docker) | Description |
|----------|------------------|-------------|
| `SF_FINANCE_HOST` | `0.0.0.0` | Server bind host |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `/data/finance.db` | SQLite database path |
| `SF_FINANCE_TOKEN` | (auto-generated) | Bearer token — overrides the token file |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed |

See the [service configuration](./finance-api#configuration) for the full reference and secrets setup.

## Volumes

| Volume | Mount | Contents |
|--------|-------|----------|
| `finance-data` | `/data` | SQLite database (`finance.db`) |
| `finance-config` | `/root/.pi/sf/finance` | Auto-generated bearer token + config |

> **Both volumes are required.** The `finance-config` volume ensures your bearer token survives restarts — without it, a new token is generated on every start and clients lose access.

## Retrieving the bearer token

The service auto-generates a bearer token on first start and writes it to `/root/.pi/sf/finance/token` inside the container (persisted via the `finance-config` volume):

```bash
docker compose exec finance-api cat /root/.pi/sf/finance/token
```

Use this token for all authenticated API requests:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7780/v1/holdings
```

The `@pi-stef/finance` extension reads this token automatically when both run on the same host. In Docker, copy the token into the extension's config (`~/.pi/sf/finance/config.json`) or set the `SF_FINANCE_TOKEN` env var.

## Healthcheck

The container includes a built-in healthcheck hitting `/v1/health` every 30s:

```bash
docker compose ps   # STATUS column shows "healthy"
```

## GHCR visibility

The first push creates the package under the `sfiorini` namespace on GHCR. By default the image inherits the repository's visibility (private for a private repo). To allow unauthenticated pulls, set the package to **public** in the GitHub UI:

1. Go to the [repository packages page](https://github.com/sfiorini/pi-stef/pkgs/container/pi-stef%2Ffinance-api)
2. Click **Package settings** → **Change visibility** → **Public**

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | Token mismatch — retrieve it from the container and update client config |
| Port already in use | Change `SF_FINANCE_PORT` and the compose port mapping (`7780:7780`) |
| `better-sqlite3` build fails (building from source) | Use the prebuilt GHCR image; building from source needs `python3`, `make`, `g++` |
| Can't reach service from another container | Use `finance-api` as the hostname on the same Docker network, or set `SF_FINANCE_HOST=0.0.0.0` |
| Healthcheck never goes healthy | Check `docker compose logs finance-api`; ensure the `finance-data` volume is writable |
| Image pull fails (private package) | Make the GHCR package public (see [GHCR visibility](#ghcr-visibility) above) |

## Native (non-Docker) alternative

The service can also run natively with `pnpm serve`. See the [finance-api page](./finance-api#quick-start) for setup.
