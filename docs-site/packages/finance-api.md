# finance-api

Always-on local service for financial data ingestion, storage, and deterministic quant analysis. Backed by SQLite; powers the [`finance`](./finance.md) extension.

## Quick start

### Docker (recommended)

```bash
cd packages/finance-api/docker
docker compose up -d
```

Pulls the multi-arch image `ghcr.io/sfiorini/pi-stef/finance-api:latest` and starts the service. By default it binds to `127.0.0.1:7780` (localhost only) — if the pi client runs on a **different machine**, change the port mapping to `"7780:7780"`. See the [Docker guide](./finance-api-docker#port-binding-same-machine-vs-remote-server) for details, volumes, image tags, and token retrieval.

### Native

```bash
pnpm install
pnpm serve
```

### Verify

```bash
curl http://127.0.0.1:7780/v1/health
# {"ok":true,"data":{"status":"ok","uptimeS":0}}
```

## Architecture: server vs client

finance-api is a **server** that typically runs in Docker on a machine you control (your laptop, a home server, a VPS). The **client** is the `finance` extension, which runs wherever you use pi.

| Component | Runs where | Config location |
|-----------|-----------|-----------------|
| **finance-api** (this package) | Docker container or native on a server | Environment variables + `/data/` volume (Docker) or `~/.pi/sf/finance/` (native) |
| **finance** (client extension) | Inside pi, on your workstation | `~/.pi/sf/finance/config.json` on **your** machine |

When the server runs in Docker, its filesystem is inside the container — the paths below starting with `~/.pi/sf/finance/` refer to the **container's** filesystem (mapped to the `finance-config` Docker volume), not your local machine.

## Authentication

All endpoints except `/v1/health` require `Authorization: Bearer <token>`. On first start the server generates a random token and writes it to `~/.pi/sf/finance/token` inside the container (`chmod 600`). In Docker, retrieve it with:

```bash
docker compose exec finance-api cat /root/.pi/sf/finance/token
```

Copy this token into the client's `config.json` on your workstation (see [finance extension](./finance#configuration)). Override with `SF_FINANCE_TOKEN` to pin a token.

## Configuration

### Server settings (env vars)

These configure the **server** — set them in `docker-compose.yml` (environment section) or your shell:

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Server bind host |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `~/.pi/sf/finance/finance.db` (`/data/finance.db` in Docker) | SQLite database path |
| `SF_FINANCE_TOKEN` | (auto-generated) | Bearer token |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed |

### Client settings (config.json)

The **client extension** reads its config from `~/.pi/sf/finance/config.json` on the machine running pi — this is **your workstation**, not the server. See [finance extension docs](./finance#configuration) for the full schema.

### Provider credentials

Working providers in this release do **not** use the server's `secrets.json`:

- **SnapTrade** — credentials live in the **client's** `config.json` and are sent per-request. See the [SnapTrade guide](./finance-api-snaptrade).
- **File Import** — no stored credentials; the file path is provided per-request.

The `secrets.json` file (at `~/.pi/sf/finance/secrets.json` on the server) is reserved for future server-side providers (Coinbase, SimpleFIN, Teller) that are currently stubs.

## Providers

Providers are **co-equal** — enable any combination, and multiple providers run side by side (e.g. SnapTrade for live brokerage sync *and* File Import for a bank OFX export).

| Provider | Kind | Status |
|----------|------|--------|
| [File Import](./finance-api-file-import) | brokerage/banking | ✅ Working |
| Coinbase | crypto | ⚠️ Stub |
| [SnapTrade](./finance-api-snaptrade) | brokerage | ✅ Working |
| SimpleFIN | banking | ⚠️ Stub |
| Teller | banking | ⚠️ Stub |

> **⚠️ Cross-provider deduplication is not supported yet.** If the same real-world account surfaces through two providers, it appears as two separate accounts — there is no merge logic today. Use one provider per account for now.

## File Import

Import **CSV** (holdings/positions) or **OFX** (transactions/balances) via the API:

```bash
curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer $(cat ~/.pi/sf/finance/token)" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/path/to/positions.csv"}'
```

> **Full details:** exact CSV column specs, numeric parsing rules, known limitations, OFX format docs, export walkthroughs, and troubleshooting — see the [File Import guide](./finance-api-file-import).

## HTTP API

Base URL `http://127.0.0.1:7780`. Responses are `{ "ok": true, "data": {...} }`.

### Interactive docs

The API ships with auto-generated OpenAPI 3.1 documentation:

- **Swagger UI**: `http://127.0.0.1:7780/docs` — interactive API explorer (try requests live)
- **OpenAPI JSON**: `http://127.0.0.1:7780/openapi.json` — raw spec for importing into Postman, Insomnia, etc.

Both endpoints are public (no auth) and generated from Zod route schemas, so they're always in sync.

### Postman collection

Import the collection and environment from the finance-api `postman/` directory:
1. Postman → Import → select `postman/finance-api.postman_collection.json`
2. Import → select `postman/finance-api.postman_environment.json`
3. Set the `token` variable to your bearer token

Regenerate after route changes: `npx tsx packages/finance-api/scripts/gen-postman.mjs`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/health` | Health check (public) |
| GET | `/v1/market-status` | Current market session |
| GET | `/v1/holdings` | All holdings |
| GET | `/v1/net-worth` | Total portfolio value |
| GET | `/v1/allocation` | Current allocation |
| GET | `/v1/drift` | Drift vs target |
| GET | `/v1/goals` | List goals |
| POST | `/v1/goals` | Create/update goal |
| GET | `/v1/suggestions` | Pending suggestions |
| POST | `/v1/suggestions/dismiss` | Dismiss a suggestion |
| POST | `/v1/sync` | Trigger a sync tick |
| POST | `/v1/import` | Import from CSV/OFX |
| GET | `/v1/history?symbol=` | Price history |
| POST | `/v1/export` | Export (json/sqlite) |

See the [API reference](./finance-api#http-api) for per-endpoint request/response schemas.

## Data model

SQLite tables: `accounts`, `holdings`, `transactions`, `prices`, `lots`, `goals`, `suggestion_records`, `market_sessions`. Versioned migrations; future changes are additive.

## Scheduler & quant engine

A session-aware scheduler runs periodic ticks: ingest → refresh prices → recompute suggestions (drift, rebalance, risk, DCA). All numbers are computed by pure, deterministic functions — the LLM client cites them verbatim and never recomputes. `POST /v1/sync` triggers a tick on demand.

## Disclaimer

**This is not financial advice.** Suggestions are informational only — no trades are executed automatically.
