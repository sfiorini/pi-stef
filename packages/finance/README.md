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

The `@pi-stef/finance-api` service must be running (Docker or native) and you must have its bearer token. See the [finance-api README](../finance-api/README.md) for service setup, or the [docs-site guide](../../docs-site/packages/finance-api.md).

> **Full documentation:** [docs-site/packages/finance.md](../../docs-site/packages/finance.md)

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
    },
    "simplefin": {
      "setupToken": "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS8uLi4="
    }
  }
}
```

| Field | Env override | Default | Description |
|-------|--------------|---------|-------------|
| `apiUrl` | `SF_FINANCE_API_URL` | `http://127.0.0.1:7780` | finance-api service URL |
| `token` | `SF_FINANCE_TOKEN` | (auto-read from `~/.pi/sf/finance/token`) | Bearer token for API auth |
| `providers.snaptrade.clientId` | — | — | Personal SnapTrade client ID (see [SnapTrade setup](../finance-api/README.md#snaptrade-setup)) |
| `providers.snaptrade.consumerKey` | — | — | Personal SnapTrade consumer key |
| `providers.simplefin.setupToken` | — | — | One-time SimpleFIN setup token (see [SimpleFIN setup](../finance-api/README.md#simplefin-setup)) |
| `providers.simplefin.accessUrl` | — | — | Persistent SimpleFIN access URL (auto-set after first sync) |

**Where does the token come from?** The finance-api service auto-generates a token on first start and writes it to `~/.pi/sf/finance/token`. When the extension runs on the same host, it reads that file automatically — you usually don't need to set `token` at all. In Docker, retrieve it with `docker compose exec finance-api cat /root/.pi/sf/finance/token` and copy it into `config.json`.

**SnapTrade credentials live here, not in the server.** SnapTrade uses a Personal API key that flows per-call: the extension attaches `clientId` + `consumerKey` to each `/v1/sync` request, and the server uses them for that single tick and stores nothing. This lets one finance-api deployment serve different SnapTrade users. See [SnapTrade setup](../finance-api/README.md#snaptrade-setup) for how to obtain them.

**SimpleFIN credentials live here too.** SimpleFIN uses a one-time setup token that the server exchanges for a persistent access URL on the first sync. The extension automatically writes the resolved `accessUrl` back to `config.json`, replacing the `setupToken`. See [SimpleFIN setup](../finance-api/README.md#simplefin-setup) for details.

## Tools

The extension exposes these tools to the pi agent:

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
| `sf_fin_sync_now` | Trigger a data sync (all providers, or one via `provider`) |
| `sf_fin_import_file` | Import holdings/transactions from a CSV/OFX file |
| `sf_fin_history` | Get price history |

### `sf_fin_sync_now`

Triggers a data sync: ingest from providers, refresh prices, recompute suggestions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | no | Provider ID to sync (e.g. `snaptrade`, `simplefin`). Omit to sync **all** providers. |

Behavior:
- **No `provider` arg** → syncs all providers. If `providers.snaptrade` and/or `providers.simplefin` are configured, their credentials are attached so they run alongside any server-side providers.
- **`provider: "snaptrade"`** → syncs **only** SnapTrade, attaching your key.
- **`provider: "snaptrade"` but no key configured** → sends the scoped request with no credentials; the server skips SnapTrade (silent no-op).
- **`provider: "simplefin"`** → syncs **only** SimpleFIN, attaching your `setupToken` or `accessUrl`.
- **`provider: "simplefin"` but no creds configured** → scoped request with no credentials; the server skips SimpleFIN (silent no-op).

> **SimpleFIN auto-persist:** On the first sync with a `setupToken`, the server exchanges it for an `accessUrl` and returns it in the response. The extension automatically writes the `accessUrl` to `config.json`, replacing the `setupToken`. You never need to manually update the config after the first sync.

### `sf_fin_import_file`

Imports holdings (CSV) or transactions + balance (OFX) from a file. The format is detected from the extension/contents. See the [File Import guide](../finance-api/README.md#file-import-csvofx) for accepted formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | **yes** | Absolute or relative path to the CSV/OFX file |

## Slash Commands

Every tool has a matching slash command (kebab-case). Type `/sf-fin-` in pi to see autocomplete.

| Command | Args | Example |
|---------|------|---------|
| `/sf-fin-market-status` | — | `/sf-fin-market-status` |
| `/sf-fin-get-holdings` | optional symbol | `/sf-fin-get-holdings AAPL` |
| `/sf-fin-get-net-worth` | — | `/sf-fin-get-net-worth` |
| `/sf-fin-get-drift` | — | `/sf-fin-get-drift` |
| `/sf-fin-get-allocation` | — | `/sf-fin-get-allocation` |
| `/sf-fin-list-goals` | — | `/sf-fin-list-goals` |
| `/sf-fin-set-target` | — (wizard) | `/sf-fin-set-target` |
| `/sf-fin-get-suggestions` | — | `/sf-fin-get-suggestions` |
| `/sf-fin-dismiss-suggestion` | suggestion ID | `/sf-fin-dismiss-suggestion rebalance-1` |
| `/sf-fin-sync-now` | optional provider | `/sf-fin-sync-now snaptrade` |
| `/sf-fin-import-file` | file path | `/sf-fin-import-file ~/Downloads/positions.csv` |
| `/sf-fin-history` | symbol | `/sf-fin-history AAPL` |

## Usage

Ask the pi agent:
- "What's my current portfolio allocation?"
- "How far am I from my target allocation?"
- "What should I buy/sell to rebalance?"
- "Sync my SnapTrade accounts"
- "Sync my SimpleFIN bank accounts"
- "Import the positions CSV at ~/Downloads/positions.csv"

## Disclaimer

**This is not financial advice.** The suggestions are computed deterministically from your configured goals and current holdings. The LLM applies judgment but never recomputes the numbers. Always consult a qualified financial advisor before making investment decisions.

## License

[MIT](../../LICENSE)
