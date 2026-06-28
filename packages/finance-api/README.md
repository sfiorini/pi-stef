# @pi-stef/finance-api

Always-on local service for financial data ingestion, storage, and deterministic quant analysis.

## Install

### Docker (Recommended)

```bash
cd packages/finance-api/docker
docker compose up --build
```

The service will be available at `http://127.0.0.1:7780`.

### Native

```bash
pnpm install
pnpm serve
```

See [docs/native-run.md](docs/native-run.md) for launchd/systemd setup.

## Configuration

Environment variables (prefix `SF_FINANCE_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_HOST` | `127.0.0.1` | Server host (use `0.0.0.0` for Docker) |
| `SF_FINANCE_PORT` | `7780` | Server port |
| `SF_FINANCE_DB` | `~/.pi/sf/finance/finance.db` | SQLite database path |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed (`stooq` or `yfinance`) |

## Secrets

Create `~/.pi/sf/finance/secrets.json` with provider credentials:

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

The file is automatically `chmod 600` on creation.

## Providers

| Provider | Kind | Auth | Status |
|----------|------|------|--------|
| File Import (CSV/OFX) | brokerage/banking | `filePath` | ✅ Working |
| Coinbase | crypto | `keyName` + `privateKey` | ⚠️ Stub (HMAC not implemented) |
| SnapTrade | brokerage | `clientId` + `consumerKey` | ⚠️ Stub |
| SimpleFIN | banking | `accessKey` | ⚠️ Stub |
| Teller | banking | `token` | ⚠️ Stub |

## First Run

1. Start the service
2. Import holdings: `POST /v1/import {"filePath": "positions.csv"}`
3. Set investment goal: `POST /v1/goals {"id": "g1", "name": "Growth", "targetAllocation": {"equity": 0.8, "bonds": 0.2}}`
4. Check drift: `GET /v1/drift`

## API

All endpoints (except `/v1/health`) require `Authorization: Bearer <token>` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/health` | Health check (public) |
| GET | `/v1/market-status` | Current market session |
| GET | `/v1/holdings` | All holdings |
| GET | `/v1/net-worth` | Total portfolio value |
| GET | `/v1/drift` | Allocation drift |
| GET | `/v1/allocation` | Current allocation |
| GET | `/v1/goals` | Investment goals |
| POST | `/v1/goals` | Create/update goal |
| GET | `/v1/suggestions` | Pending suggestions |
| POST | `/v1/suggestions/dismiss` | Dismiss suggestion |
| POST | `/v1/sync` | Trigger sync |
| POST | `/v1/import` | Import from file |
| GET | `/v1/history` | Price history |
| POST | `/v1/export` | Export data |

## Cost

- **Free tier**: File imports (CSV/OFX) — no API costs
- **Optional**: Coinbase API (free, view-only scope)
- **Optional**: SnapTrade/SimpleFIN/Teller aggregators (may have fees)

## Disclaimer

**This is not financial advice.** The service provides deterministic calculations based on your data and configured goals. Suggestions are informational only — no trades are executed automatically.

## License

[MIT](../../LICENSE)
