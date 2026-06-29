# Finance

Portfolio tracking, drift analysis, and deterministic investment suggestions.

## Overview

The `@pi-stef/finance` extension connects to the `@pi-stef/finance-api` service to provide:

- **Portfolio tracking** — consolidate holdings from brokerage, retirement, banking, and crypto accounts
- **Allocation drift** — compare current vs target allocation
- **Rebalance suggestions** — deterministic buy/sell recommendations
- **Risk checks** — concentration and cash-drag alerts
- **DCA scheduling** — dollar-cost averaging recommendations

## Install

```bash
pi install npm:@pi-stef/finance
```

Or via catalog:
```bash
/ct add npm:@pi-stef/finance
```

## Prerequisites

The `@pi-stef/finance-api` service must be running. See the [finance-api guide](./finance-api.md) for Docker/native setup.

## Configuration

Set environment variables or create `~/.pi/sf/finance/config.json`:

```json
{
  "apiUrl": "http://127.0.0.1:7780",
  "token": "your-bearer-token"
}
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_API_URL` | `http://127.0.0.1:7780` | Finance API URL |
| `SF_FINANCE_TOKEN` | (auto-generated) | Bearer token |

## Tools

The extension exposes 12 tools to the pi agent. Parameters marked **required** must be provided; others are optional.

### `sf_fin_market_status`
Get the current US market session (`pre` / `regular` / `post` / `closed`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_get_holdings`
All account holdings with quantities and asset classes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

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
Trigger an immediate data sync (ingest + prices + recompute).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

### `sf_fin_import_file`
Import holdings from a CSV/OFX export.

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

## Usage Examples

```
"What's my current portfolio allocation?"
"How far am I from my target allocation?"
"What should I buy/sell to rebalance?"
"Import my Fidelity positions from ~/Downloads/positions.csv"
```

## Disclaimer

**This is not financial advice.** Suggestions are computed deterministically from your configured goals and current holdings. Always consult a qualified financial advisor before making investment decisions.
