# finance-api

Always-on local service for financial data ingestion, storage, and deterministic quant analysis. Backed by SQLite; powers the [`finance`](./finance.md) extension.

## Quick start

### Docker (recommended)

```bash
cd packages/finance-api/docker
docker compose up -d
```

Pulls the multi-arch image `ghcr.io/sfiorini/pi-stef/finance-api:latest` and serves the API at `http://127.0.0.1:7780`. See the [Docker guide](https://github.com/sfiorini/pi-stef/tree/main/packages/finance-api/docker) for volumes, image tags, and token retrieval.

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

## Authentication

All endpoints except `/v1/health` require `Authorization: Bearer <token>`. On first start a random token is generated and written to `~/.pi/sf/finance/token` (`chmod 600`); it persists across restarts. In Docker:

```bash
docker compose exec finance-api cat /root/.pi/sf/finance/token
```

Override with the `SF_FINANCE_TOKEN` env var to pin a token.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Server bind host |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `~/.pi/sf/finance/finance.db` | SQLite database path |
| `SF_FINANCE_TOKEN` | (auto-generated) | Bearer token |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed |

Provider credentials live in `~/.pi/sf/finance/secrets.json` (chmod 600). See the [service README](https://github.com/sfiorini/pi-stef/tree/main/packages/finance-api) for the full reference.

## Providers

| Provider | Kind | Status |
|----------|------|--------|
| File Import (CSV/OFX) | brokerage/banking | ✅ Working |
| Coinbase | crypto | ⚠️ Stub |
| SnapTrade | brokerage | ⚠️ Stub |
| SimpleFIN | banking | ⚠️ Stub |
| Teller | banking | ⚠️ Stub |

Import a CSV via the API: `POST /v1/import {"filePath": "/path/to/positions.csv"}`.

## HTTP API

Base URL `http://127.0.0.1:7780`. Responses are `{ "ok": true, "data": {...} }`.

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

See the [service README](https://github.com/sfiorini/pi-stef/tree/main/packages/finance-api) for per-endpoint request/response schemas.

## Data model

SQLite tables: `accounts`, `holdings`, `transactions`, `prices`, `lots`, `goals`, `suggestion_records`, `market_sessions`. Versioned migrations; future changes are additive.

## Scheduler & quant engine

A session-aware scheduler runs periodic ticks: ingest → refresh prices → recompute suggestions (drift, rebalance, risk, DCA). All numbers are computed by pure, deterministic functions — the LLM client cites them verbatim and never recomputes. `POST /v1/sync` triggers a tick on demand.

## Disclaimer

**This is not financial advice.** Suggestions are informational only — no trades are executed automatically.
