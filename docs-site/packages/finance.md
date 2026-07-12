# Finance

Portfolio tracking, drift analysis, and deterministic investment suggestions.

## Overview

The `@pi-stef/finance` extension connects to the `@pi-stef/finance-api` service to provide:

- **Portfolio tracking** — consolidate holdings from brokerage, retirement, banking, and crypto accounts
- **Allocation drift** — compare current vs target allocation
- **Rebalance suggestions** — deterministic buy/sell recommendations
- **Risk checks** — concentration and cash-drag alerts
- **DCA scheduling** — dollar-cost averaging recommendations

## Architecture

Two packages work together:

- **`@pi-stef/finance-api`** — an always-on local service (Docker or native) that ingests data from providers, stores it in SQLite, and runs a deterministic quant engine. See the [finance-api guide](./finance-api.md).
- **`@pi-stef/finance`** — the pi extension you install here. It calls the service over an authenticated HTTP API and exposes its data as tools to the pi agent.

You run the service once, then install the extension wherever you use pi.

## Install

```bash
pi install npm:@pi-stef/finance
```

Or via catalog:
```bash
/ct add npm:@pi-stef/finance
```

## Prerequisites

The `@pi-stef/finance-api` service must be running and you need its bearer token. See the [finance-api guide](./finance-api.md) for Docker/native setup and [Docker guide](./finance-api-docker.md) for the container image.

## Configuration

The extension reads its config from `~/.pi/sf/finance/config.json`, or from environment variables (prefix `SF_FINANCE_`):

```json
{
  "apiUrl": "http://127.0.0.1:7780",
  "token": "your-bearer-token",
  "providers": {
    "snaptrade": {
      "clientId": "PERS-...",
      "consumerKey": "<your personal consumer key>"
    }
  }
}
```

| Field | Env override | Default | Description |
|-------|--------------|---------|-------------|
| `apiUrl` | `SF_FINANCE_API_URL` | `http://127.0.0.1:7780` | finance-api service URL |
| `token` | `SF_FINANCE_TOKEN` | (auto-read from `~/.pi/sf/finance/token`) | Bearer token |
| `providers.snaptrade.clientId` | — | — | Personal SnapTrade client ID |
| `providers.snaptrade.consumerKey` | — | — | Personal SnapTrade consumer key |

**Token lookup:** when the extension runs on the same host as the service, it reads the auto-generated token from `~/.pi/sf/finance/token` automatically — you usually don't set `token` at all. In Docker, copy the service token into `config.json` (retrieve it with `docker compose exec finance-api cat /root/.pi/sf/finance/token`).

**SnapTrade credentials:** SnapTrade uses a Personal API key that flows per-call — the extension attaches it to each sync request, and the server stores nothing. One finance-api can serve different SnapTrade users. See the [SnapTrade guide](./finance-api-snaptrade) for how to obtain the key.

## Tools

The extension exposes tools to the pi agent. Parameters marked **required** must be provided; others are optional.

### `sf_fin_market_status`
Get the current US market session (`pre` / `regular` / `post` / `closed`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_get_holdings`
All account holdings with quantities, prices, market values, and gain/loss. Supports optional filtering by account or symbol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accountId` | string | no | Filter to a single account ID |
| `symbol` | string | no | Filter to a single ticker (e.g. `AAPL`) across all accounts |

### `sf_fin_get_net_worth`
Total portfolio value across all accounts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_get_drift`
Allocation drift vs the configured target.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_get_allocation`
Current asset allocation breakdown by class.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_list_goals`
List configured investment goals and their target allocations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_set_target`
Create or update an investment goal.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | **yes** | Goal identifier |
| `name` | string | **yes** | Display name |
| `targetAllocation` | object | **yes** | Asset-class weights (must sum to ~1.0) |
| `riskLimits` | object | no | Risk limits (e.g. `maxSinglePosition`, `maxCashDrag`) |
| `horizonYears` | number | no | Investment horizon in years |

### `sf_fin_get_suggestions`
Pending deterministic suggestions from the quant engine (drift, rebalance, risk, DCA).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_dismiss_suggestion`
Dismiss a suggestion that's been addressed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | **yes** | Suggestion ID to dismiss |

### `sf_fin_sync_now`
Trigger a data sync: ingest from providers, refresh prices, recompute suggestions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | no | Provider ID to sync (e.g. `snaptrade`). Omit to sync **all** providers. |

Behavior:
- **No `provider` arg** → syncs all providers. If `providers.snaptrade` is configured, your Personal SnapTrade key is attached so SnapTrade runs alongside any server-side providers.
- **`provider: "snaptrade"`** → syncs **only** SnapTrade, attaching your key.
- **`provider: "snaptrade"` but no key configured** → scoped request with no credentials; the server skips SnapTrade (silent no-op).

### `sf_fin_import_file`
Import holdings (CSV) or transactions + balance (OFX) from a file export. Format is auto-detected. See the [File Import guide](./finance-api-file-import) for accepted formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | **yes** | Path to the CSV/OFX file |

### `sf_fin_history`
Price history for a symbol, newest first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | **yes** | Ticker (e.g. `AAPL`, `CRYPTO:BTC`) |
| `accountId` | string | no | Filter to prices relevant to an account |

> **Guideline:** All numbers come from the service. Never recompute prices, allocations, or drift yourself — cite the returned values verbatim.

## Providers

The extension syncs data from any providers configured on the service (plus SnapTrade, which is client-supplied). Providers are **co-equal** and can be combined — e.g. SnapTrade for live brokerage sync and File Import for a bank OFX export. See the [finance-api providers](./finance-api#providers) for the full list, and the dedicated guides:

- [SnapTrade](./finance-api-snaptrade) — live brokerage aggregation (30+ brokers)
- [File Import](./finance-api-file-import) — manual CSV/OFX uploads

> **Cross-provider deduplication is not supported yet.** If the same account surfaces through two providers, it appears as two separate accounts. Use one provider per account for now.

## Usage Examples

```
"What's my current portfolio allocation?"
"How far am I from my target allocation?"
"What should I buy/sell to rebalance?"
"Sync my SnapTrade accounts"
"Import the positions CSV at ~/Downloads/positions.csv"
```

## Disclaimer

**This is not financial advice.** Suggestions are computed deterministically from your configured goals and current holdings. Always consult a qualified financial advisor before making investment decisions.
