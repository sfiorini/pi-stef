# finance-api

Always-on local service for financial data ingestion, storage, and deterministic quant analysis. Backed by SQLite; powers the [`finance`](./finance.md) extension.

## Quick start

### Docker (recommended)

```bash
cd packages/finance-api/docker
docker compose up -d
```

Pulls the multi-arch image `ghcr.io/sfiorini/pi-stef/finance-api:latest` and serves the API at `http://127.0.0.1:7780`. See the [Docker guide](./finance-api-docker) for volumes, image tags, and token retrieval.

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

Provider credentials live in `~/.pi/sf/finance/secrets.json` (chmod 600).

## Providers

| Provider | Kind | Status |
|----------|------|--------|
| File Import (CSV/OFX) | brokerage/banking | ✅ Working |
| Coinbase | crypto | ⚠️ Stub |
| [SnapTrade](./finance-api-snaptrade) | brokerage | ✅ Working |
| SimpleFIN | banking | ⚠️ Stub |
| Teller | banking | ⚠️ Stub |

Import a CSV via the API: `POST /v1/import {"filePath": "/path/to/positions.csv"}`.

## Data Import

The service supports **CSV** (holdings/positions) and **OFX** (transactions/balances).

### Supported formats

| Format | Accepts | Data imported |
|--------|----------|---------------|
| CSV | `.csv` | Holdings (Symbol + Quantity + optional Price) |
| OFX | `.ofx`, `.qfx` | Transactions + cash balance |

### Quick CSV import

Your CSV must have a header row with columns for `Symbol` (or `symbol`) and `Quantity` (or `shares` / `qty`). A `Last Price` or `Price` column is optional.

```bash
curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer $(cat ~/.pi/sf/finance/token)" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/path/to/fidelity-positions.csv"}'
```

### Fidelity export (verified)

Fidelity exports positions with the exact headers the parser expects: `Account,Symbol,Description,Quantity,Last Price`. Export from **Accounts & Trade** → **Portfolio** → **Download** → CSV.

### Other services

| Service | Status | Alternative |
|---------|--------|-------------|
| Coinbase | ❌ Not supported (exports transactions, not positions) | Manually create a `Symbol,Quantity` CSV |
| Bank of America | ❌ Not supported for CSV (exports activity) | Use OFX/QFX download instead |
| Vanguard, Schwab, others | ⚠️ Untested | Try it — if headers match, it should work |

> **Full details:** See the [Data Import guide](./finance-api-data-import) — exact CSV column specs, numeric parsing rules, known limitations, OFX format docs, export walkthroughs, and a troubleshooting table with 8 common scenarios.

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

See the [API reference](./finance-api#http-api) for per-endpoint request/response schemas.

## Data model

SQLite tables: `accounts`, `holdings`, `transactions`, `prices`, `lots`, `goals`, `suggestion_records`, `market_sessions`. Versioned migrations; future changes are additive.

## Scheduler & quant engine

A session-aware scheduler runs periodic ticks: ingest → refresh prices → recompute suggestions (drift, rebalance, risk, DCA). All numbers are computed by pure, deterministic functions — the LLM client cites them verbatim and never recomputes. `POST /v1/sync` triggers a tick on demand.

## Disclaimer

**This is not financial advice.** Suggestions are informational only — no trades are executed automatically.
