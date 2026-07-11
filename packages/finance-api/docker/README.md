# finance-api Docker

The `@pi-stef/finance-api` service is published as a multi-arch Docker image to the GitHub Container Registry.

## Quick start

```bash
cd packages/finance-api/docker
docker compose up -d
```

This pulls `ghcr.io/sfiorini/pi-stef/finance-api:latest` and starts the service.

Check it's running:

```bash
curl http://127.0.0.1:7780/v1/health
# {"ok":true,"data":{"status":"ok","uptimeS":0}}
```

## Port binding: same machine vs remote server

The default compose file binds to `127.0.0.1:7780:7780` — **localhost only**. This is the right choice when the pi client and the finance-api service run on the same host. The service is invisible to the LAN.

If the finance-api service runs on a **different machine** (e.g. a home server) and the pi client connects to it over the network, change the port mapping so the service is reachable from the LAN:

```yaml
ports:
  # Same machine (default, most secure):
  - "127.0.0.1:7780:7780"
  # Remote server (LAN-accessible) — comment the line above, uncomment this:
  # - "7780:7780"
```

With `"7780:7780"` the service listens on all interfaces. The bearer token still protects every API endpoint, so this is safe on a trusted LAN. For untrusted networks, keep `127.0.0.1` and use an SSH tunnel instead:

```bash
ssh -L 7780:127.0.0.1:7780 your-server
# Then access the service at http://127.0.0.1:7780
```

When using the remote-server mode, set the client's `apiUrl` to the server's hostname or IP:

```json
{ "apiUrl": "http://your-server:7780", "token": "..." }
```

## Image

| Registry | Image |
|----------|-------|
| GHCR | `ghcr.io/sfiorini/pi-stef/finance-api` |

**Tags:**

- `latest` — most recent release
- `X.Y.Z` — pinned release (e.g. `0.1.0`)

**Platforms:** `linux/amd64`, `linux/arm64` (Intel Macs / Linux servers + Apple Silicon).

```bash
# Pull a specific version
docker pull ghcr.io/sfiorini/pi-stef/finance-api:0.1.0
```

The image is built from the repo source on every `@pi-stef/finance-api@X.Y.Z` tag push (see `.github/workflows/docker.yml`), so it always matches the released npm package.

## Build from source (local dev)

To build the image locally instead of pulling from the registry:

```bash
cd packages/finance-api/docker
# Uncomment the `build:` block in docker-compose.yml, then:
docker compose up --build
```

Or build directly with `docker build`:

```bash
docker build -f packages/finance-api/docker/Dockerfile -t finance-api:dev .
```

The Dockerfile is a multi-stage source build. The build stage installs `python3`/`make`/`g++` to compile `better-sqlite3` native bindings; the runtime stage is slim and ships only the compiled app plus `curl` for healthchecks.

## Configuration

All configuration is via environment variables (prefix `SF_FINANCE_`), set automatically by `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_HOST` | `0.0.0.0` (container) | Server bind host |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `/data/finance.db` | SQLite database path |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed |

See the [service README](../README.md) for the full configuration and secrets reference.

## Volumes

Two named volumes persist data across container restarts:

| Volume | Mount | Contents |
|--------|-------|----------|
| `finance-data` | `/data` | SQLite database (`finance.db`) |
| `finance-config` | `/root/.pi/sf/finance` | Auto-generated bearer token + config |

> **Important:** both volumes are required. The token volume (`finance-config`) ensures your bearer token survives restarts — without it, a new token is generated on every start and clients lose access.

## Retrieving the bearer token

The service auto-generates a bearer token on first start and writes it to `/root/.pi/sf/finance/token` inside the container (persisted via the `finance-config` volume). Retrieve it with:

```bash
docker compose exec finance-api cat /root/.pi/sf/finance/token
```

Use this token for all authenticated API requests:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7780/v1/holdings
```

The `@pi-stef/finance` extension client reads this token automatically when both run on the same host. In Docker, copy the token into the extension's config (`~/.pi/sf/finance/config.json`) or the `SF_FINANCE_TOKEN` env var.

## Healthcheck

The container includes a built-in healthcheck hitting `/v1/health` every 30s:

```bash
docker compose ps   # STATUS column shows "healthy"
```

## GHCR visibility

The first push creates the package under the `sfiorini` namespace on GHCR. By default the image inherits the repository's visibility (private for a private repo). To allow unauthenticated pulls, set the package to **public** in GitHub → Packages → `pi-stef/finance-api` → Package settings.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | Token mismatch — retrieve it from the container (above) and update client config |
| Port already in use | Change `SF_FINANCE_PORT` and the compose port mapping |
| `better-sqlite3` build fails | Use the prebuilt registry image; building from source requires the build stage's toolchain |
| Can't reach service from another machine | Port bound to `127.0.0.1` only — change to `"7780:7780"` in docker-compose.yml (see [Port binding](#port-binding-same-machine-vs-remote-server) above) |
| Can't reach service from another container | Use the service name `finance-api` as the hostname, or set `SF_FINANCE_HOST=0.0.0.0` and join the same Docker network |
| Healthcheck never goes healthy | Check `docker compose logs finance-api`; ensure the DB volume is writable |

## Native (non-Docker) alternative

See [docs/native-run.md](../docs/native-run.md) for launchd/systemd setup without Docker.
