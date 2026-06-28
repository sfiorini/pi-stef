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

The `@pi-stef/finance-api` service must be running. See the [finance-api README](https://github.com/sfiorini/pi-stef/tree/main/packages/finance-api) for Docker/native setup.

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

| Tool | Description |
|------|-------------|
| `sf_fin_market_status` | Get current US market session |
| `sf_fin_get_holdings` | Get all account holdings |
| `sf_fin_get_net_worth` | Get total portfolio value |
| `sf_fin_get_drift` | Get allocation drift vs target |
| `sf_fin_get_allocation` | Get current asset allocation |
| `sf_fin_list_goals` | List investment goals |
| `sf_fin_set_target` | Create/update investment goal |
| `sf_fin_get_suggestions` | Get pending suggestions |
| `sf_fin_dismiss_suggestion` | Dismiss a suggestion |
| `sf_fin_sync_now` | Trigger immediate data sync |
| `sf_fin_import_file` | Import holdings from CSV/OFX |
| `sf_fin_history` | Get price history |

## Usage Examples

```
"What's my current portfolio allocation?"
"How far am I from my target allocation?"
"What should I buy/sell to rebalance?"
"Import my Fidelity positions from ~/Downloads/positions.csv"
```

## Disclaimer

**This is not financial advice.** Suggestions are computed deterministically from your configured goals and current holdings. Always consult a qualified financial advisor before making investment decisions.
