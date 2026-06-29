# @pi-stef/finance-api

Always-on local service for financial data ingestion, storage, and deterministic quant analysis. Backed by SQLite; serves a bearer-token-authenticated HTTP API to the `@pi-stef/finance` extension and any other client.

---

## Quick start

### Docker (recommended)

```bash
cd packages/finance-api/docker
docker compose up -d
```

Pulls `ghcr.io/sfiorini/pi-stef/finance-api:latest` and starts the service at `http://127.0.0.1:7780`. See the [Docker guide](docker/README.md) for image tags, volumes, and retrieving the token.

### Native

```bash
pnpm install
pnpm serve
```

See [docs/native-run.md](docs/native-run.md) for launchd/systemd setup.

### Verify

```bash
curl http://127.0.0.1:7780/v1/health
# {"ok":true,"data":{"status":"ok","uptimeS":0}}
```

---

## Authentication

All endpoints except `/v1/health` require a bearer token via the `Authorization` header:

```
Authorization: Bearer <token>
```

**Token lifecycle:**

- On first start, the service generates a random UUID token and writes it to `~/.pi/sf/finance/token` (`chmod 600`), created atomically and race-safe via `O_EXCL`.
- The token is stable across restarts as long as the token file persists.
- In Docker, the token is stored inside the container at `/root/.pi/sf/finance/token` and persists via the `finance-config` volume. Retrieve it with:
  ```bash
  docker compose exec finance-api cat /root/.pi/sf/finance/token
  ```

**Override:** Set `SF_FINANCE_TOKEN` to pin a specific token (useful for CI or sharing across hosts).

The `@pi-stef/finance` extension reads this token automatically when co-located on the same host.

---

## Configuration

All configuration is via environment variables (prefix `SF_FINANCE_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Server bind host |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `~/.pi/sf/finance/finance.db` (`/data/finance.db` in Docker) | SQLite database path |
| `SF_FINANCE_TOKEN` | (auto-generated) | Bearer token (overrides the token file) |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed (`stooq`) |

### Secrets (`secrets.json`)

Create `~/.pi/sf/finance/secrets.json` with provider credentials. The file is `chmod 600` on creation.

```json
{
  "coinbase": {
    "keyName": "your-api-key",
    "privateKey": "your-private-key"
  },
  "fidelity": {
    "filePath": "~/Downloads/fidelity-positions.csv"
  },
  "boa": {
    "filePath": "~/Downloads/boa-transactions.ofx"
  }
}
```

Each provider's required credentials are documented under [Providers](#providers).

---

## Providers

| Provider | Kind | Auth (in `secrets.json`) | Status |
|----------|------|--------------------------|--------|
| File Import (CSV/OFX) | brokerage/banking | `filePath` | ✅ Working |
| Coinbase | crypto | `keyName` + `privateKey` | ⚠️ Stub (HMAC not implemented) |
| SnapTrade | brokerage | `clientId` + `consumerKey` | ⚠️ Stub |
| SimpleFIN | banking | `accessKey` | ⚠️ Stub |
| Teller | banking | `token` | ⚠️ Stub |

**Provider setup:**

- **File Import (CSV)** — Export positions from your brokerage (e.g. Fidelity's Positions download) and point `filePath` at the CSV. Supported columns: symbol, quantity, last price. Call `POST /v1/import` with the path to ingest.
- **File Import (OFX)** — Export transactions from your bank in OFX format and point `filePath` at it.
- **Coinbase / SnapTrade / SimpleFIN / Teller** — Stubs in the current release. Credentials are accepted and validated against the contract, but live API calls are not yet implemented. Tracked for a future release.

---

## HTTP API reference

Base URL: `http://127.0.0.1:7780`. All endpoints return `{ "ok": true, "data": {...} }` on success or `{ "ok": false, "error": { "code": "...", "message": "..." } }` on failure.

### `GET /v1/health` *(public)*

Health check; no auth required.

```json
{ "ok": true, "data": { "status": "ok", "uptimeS": 123 } }
```

### `GET /v1/market-status`

Returns the current US market session classification.

```json
{ "ok": true, "data": { "session": "regular", "timestamp": 1782000000000 } }
```

`session` is one of `pre`, `regular`, `post`, `closed`. Holiday list currently covers 2026.

### `GET /v1/holdings`

Accounts and their holdings.

```json
{ "ok": true, "data": { "accounts": [
  { "id": "fidelity", "provider_id": "import", "kind": "brokerage", "name": "Fidelity",
    "holdings": [ { "account_id": "fidelity", "symbol": "AAPL", "quantity": 10, "asset_class": "equity", "as_of": 1782000000000 } ] }
] } }
```

### `GET /v1/net-worth`

Total portfolio value using latest prices (falls back to average cost).

```json
{ "ok": true, "data": { "netWorth": 123456.78, "accountCount": 3 } }
```

### `GET /v1/allocation`

Current asset allocation as flat weights by asset class.

```json
{ "ok": true, "data": { "allocation": { "equity": 0.72, "bonds": 0.18, "cash": 0.10 }, "totalValue": 123456.78 } }
```

### `GET /v1/drift`

Allocation drift vs the configured goal's target allocation.

```json
{ "ok": true, "data": { "drift": [
  { "class": "equity", "currentPct": 0.72, "targetPct": 0.80, "deltaPct": -0.08, "value": 88888.0 }
] } }
```

### `GET /v1/goals`

List investment goals (target allocation is parsed from stored JSON).

```json
{ "ok": true, "data": { "goals": [
  { "id": "g1", "name": "Growth", "targetAllocation": { "equity": 0.8, "bonds": 0.2 }, "riskLimits": {}, "horizon_years": 10 }
] } }
```

> Note: `target_allocation` and `risk_limits` are camelCased in the response (`targetAllocation`/`riskLimits`, parsed from JSON); `horizon_years` keeps its snake_case DB form.

### `POST /v1/goals`

Create or update (UPSERT) an investment goal. Validates that the target allocation sums to ~1.0.

**Request body:**

```json
{
  "id": "g1",
  "name": "Growth",
  "targetAllocation": { "equity": 0.8, "bonds": 0.2 },
  "riskLimits": { "maxConcentration": 0.25 },
  "horizonYears": 10
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Goal identifier |
| `name` | string | yes | Display name |
| `targetAllocation` | object | yes | Asset-class weights (must sum to ~1.0) |
| `riskLimits` | object | no | Risk limits (e.g. `maxConcentration`) |
| `horizonYears` | number | no | Investment horizon |

```json
{ "ok": true, "data": { "id": "g1" } }
```

### `GET /v1/suggestions`

Pending rebalance/risk/drift suggestions computed by the quant engine. Each suggestion's `payload` is parsed from stored JSON.

```json
{ "ok": true, "data": { "suggestions": [
  { "id": "s-...-0", "kind": "rebalance", "status": "pending", "payload": { "symbol": "AAPL", "action": "buy", "amount": 500 } }
] } }
```

### `POST /v1/suggestions/dismiss`

Dismiss a suggestion by id.

**Request body:** `{ "id": "s-...-0" }`

```json
{ "ok": true, "data": { "dismissed": "s-...-0" } }
```

### `POST /v1/sync`

Trigger a full scheduler tick: ingest from all configured providers, refresh prices, recompute suggestions.

```json
{ "ok": true, "data": {
  "message": "Sync complete",
  "session": "regular",
  "accountsIngested": 3,
  "holdingsIngested": 12,
  "pricesUpdated": 12,
  "suggestionsCreated": 2,
  "errors": []
} }
```

### `POST /v1/import`

Import holdings from a local file (CSV or OFX). Absolute paths are allowed (single-user local service); relative paths containing `..` are rejected.

**Request body:** `{ "filePath": "/Users/me/Downloads/fidelity-positions.csv" }`

```json
{ "ok": true, "data": { "message": "Import complete", "filePath": "...", "accounts": 1 } }
```

### `GET /v1/history?symbol=AAPL[&accountId=...]`

Price history for a symbol, newest first. `accountId` optionally filters to prices relevant to a holding in that account.

```json
{ "ok": true, "data": { "history": [
  { "symbol": "AAPL", "date": 1782000000000, "close": 210.5, "source": "stooq" }
] } }
```

### `POST /v1/export`

Export data. `format: json` returns all tables inline; `format: sqlite` writes a backup copy of the database (restricted to the finance backup directory).

**Request body:** `{ "format": "json" }` or `{ "format": "sqlite", "path": "backup.db" }`

```json
// json
{ "ok": true, "data": { "holdings": [...], "prices": [...], ... } }
// sqlite
{ "ok": true, "data": { "backupPath": "/home/.pi/sf/finance/backups/backup.db" } }
```

---

## Data model

SQLite, stored at `SF_FINANCE_DB`. Versioned migrations (see `src/store/schema.ts`); future changes add migration entries rather than mutating existing tables.

| Table | Purpose |
|-------|---------|
| `accounts` | Linked accounts (provider, kind, name, mask, currency, staleness) |
| `holdings` | Current holdings per account/symbol (quantity, avg cost, asset class, as-of) |
| `transactions` | Transactions (date, symbol, qty, price, type, fees) |
| `prices` | Price history per symbol/date (close, source) |
| `lots` | Tax lots per holding (open date, qty, cost basis) |
| `goals` | Investment goals (target allocation, risk limits, horizon) |
| `suggestion_records` | Persisted suggestions (kind, payload, status) |
| `market_sessions` | Cached market-session snapshots per date |

---

## Scheduler & quant engine

The built-in scheduler (`src/scheduler/`) runs a periodic tick whose cadence depends on the market session: more frequent intraday, hourly after hours, and every few hours when closed. Each tick:

1. **Ingests** fresh data from configured providers via the provider registry.
2. **Refreshes prices** from the configured data feed (default `stooq`).
3. **Recomputes suggestions** deterministically through the quant engine:
   - **Drift** — current vs target allocation deltas
   - **Rebalance** — buy/sell amounts to return to target
   - **Risk** — concentration and cash-drag checks against `riskLimits`
   - **DCA** — dollar-cost-averaging recommendations (where configured)

**Determinism:** all numbers are computed by pure functions in `src/quant/`. The LLM client applies judgment but never recomputes the figures. This keeps suggestions reproducible and auditable.

`POST /v1/sync` triggers a tick on demand.

---

## Backup & restore

- **JSON export:** `POST /v1/export {"format":"json"}` returns all data inline.
- **SQLite backup:** `POST /v1/export {"format":"sqlite"}` writes a timestamped `.db` copy to `~/.pi/sf/finance/backups/` (path is sandboxed to that directory).
- **Restore:** stop the service, replace `SF_FINANCE_DB` with the backup file, restart.

---

## Observability

Structured logs are emitted to stdout (JSON) with `level`, `msg`, and contextual fields. Key events: server start, ingest results, staleness warnings, tick summaries. Increase verbosity via your process supervisor's log level (the service logs at `info` by default).

---

## Security model

- **Local-first:** bind to `127.0.0.1` by default. Docker maps `127.0.0.1:7780:7780` (localhost only) so the service is not exposed to the LAN.
- **Bearer auth:** every non-health endpoint requires a token; compared with `timingSafeEqual`.
- **Secrets:** `secrets.json` is `chmod 600`; provider credentials never leave the host.
- **File imports:** absolute paths are allowed (local file access by design); relative `..` traversal is rejected.
- **Backups:** the export route sandboxes SQLite backups to the finance backup directory.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | Retrieve/regenerate the token (see [Authentication](#authentication)); check `SF_FINANCE_TOKEN` |
| Port already in use | Change `SF_FINANCE_PORT` and the compose port mapping |
| Stale holdings | Run `POST /v1/sync`; check provider credentials in `secrets.json` |
| `better-sqlite3` build fails (native) | Use the Docker image, or ensure `python3 make g++` are installed |
| No suggestions after sync | Set a goal via `POST /v1/goals` — drift/rebalance need a target |

---

## Cost

- **Free tier:** File imports (CSV/OFX) and `stooq` prices — no API costs.
- **Optional:** Coinbase API (free, view-only scope) — currently a stub.
- **Optional:** SnapTrade / SimpleFIN / Teller aggregators (may have fees) — currently stubs.

---

## Disclaimer

**This is not financial advice.** The service provides deterministic calculations based on your data and configured goals. Suggestions are informational only — no trades are executed automatically. Always consult a qualified financial advisor before making investment decisions.

## License

[MIT](../../LICENSE)
