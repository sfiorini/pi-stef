# @pi-stef/finance

Pi extension client for `@pi-stef/finance-api` — exposes portfolio state, drift, and deterministic suggestions to the pi agent.

## Install

```bash
pi install npm:@pi-stef/finance
```

Or via catalog:
```bash
/ct add npm:@pi-stef/finance
```

## Prerequisites

The `@pi-stef/finance-api` service must be running (Docker or native). See the [finance-api README](../finance-api/README.md) or the [docs-site guide](../../docs-site/packages/finance-api.md) for setup.

> **Full documentation:** [docs-site/packages/finance.md](../../docs-site/packages/finance.md)

## Configuration

Set environment variables or create `~/.pi/sf/finance/config.json`:

```json
{
  "apiUrl": "http://127.0.0.1:7780",
  "token": "your-bearer-token"
}
```

Environment variables (prefix `SF_FINANCE_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_API_URL` | `http://127.0.0.1:7780` | Finance API URL |
| `SF_FINANCE_TOKEN` | (from `~/.pi/sf/finance/token`) | Bearer token for API auth |

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

## Usage

Ask the pi agent:
- "What's my current portfolio allocation?"
- "How far am I from my target allocation?"
- "What should I buy/sell to rebalance?"
- "Import my Fidelity positions from ~/Downloads/positions.csv"

## Disclaimer

**This is not financial advice.** The suggestions are computed deterministically from your configured goals and current holdings. The LLM applies judgment but never recomputes the numbers. Always consult a qualified financial advisor before making investment decisions.

## License

[MIT](../../LICENSE)
