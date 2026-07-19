# SimpleFIN provider

SimpleFIN aggregates bank account data (checking, savings, credit cards) via the SimpleFIN Bridge. Unlike SnapTrade (investment positions), SimpleFIN provides **balances and transactions** — no holdings/positions (banking accounts have no equity).

> **SimpleFIN is a banking-only provider.** `getHoldings` always returns `[]`. Data comes from account balances and transactions. For investment positions, use SnapTrade or File Import.

## Credentials

Credentials live in the **client config** on the machine where you run pi (`~/.pi/sf/finance/config.json` on **your workstation**, not the finance-api server), **not** in the server's `secrets.json`. The `finance` extension sends them in the body of each `/v1/sync` request; the server uses them for that single tick and stores nothing.

| Field | What it is | Where it comes from |
|-------|------------|---------------------|
| `setupToken` | One-time setup token from SimpleFIN Bridge | SimpleFIN Bridge dashboard |
| `accessUrl` | Persistent access URL with embedded Basic Auth | Auto-generated after first sync (replaces `setupToken`) |

```json
{
  "apiUrl": "http://127.0.0.1:7780",
  "token": "<service bearer token>",
  "providers": {
    "simplefin": {
      "setupToken": "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS8uLi4="
    }
  }
}
```

## Auth flow (setup token → access URL)

SimpleFIN uses a one-time token exchange:

1. You obtain a **setup token** from the SimpleFIN Bridge (a base64-encoded URL, one-time use).
2. On the first sync, the finance-api server POSTs to the decoded URL and receives an **access URL** (persistent, embeds Basic Auth credentials).
3. The server returns the access URL in the sync response. The finance extension automatically writes it to your `config.json`, replacing the setup token.
4. Future syncs use the access URL directly — no re-exchange.

After first sync, config is automatically updated:

```json
{
  "providers": {
    "simplefin": {
      "accessUrl": "https://user:pass@bridge.simplefin.org/simplefin"
    }
  }
}
```

> **Note:** Setup tokens are one-time use. Once exchanged, the token is dead. The finance extension handles persistence automatically — you never need to manually update the config.

## Self-provision once

1. Visit [beta-bridge.simplefin.org](https://beta-bridge.simplefin.org) and create a SimpleFIN account.
2. Generate a setup token from the SimpleFIN Bridge dashboard.
3. Add it to your client `config.json` under `providers.simplefin.setupToken`.
4. Run `sf_fin_sync_now` — the adapter exchanges the token and persists the access URL.

## What is synced

- **Accounts** — bank accounts (checking, savings, credit cards) with balances.
- **Balances** — current balance per account, persisted as cash.
- **Transactions** — deposits, withdrawals, payments (credit/debit classification). Pending transactions are excluded.
- **No holdings** — banking accounts have no equity positions.

## Rate limits

SimpleFIN limits to **24 requests per day**. Each sync uses ~1 request (one `/accounts` call that returns all accounts with balances and transactions). This is well within the limit for daily or even hourly syncs.

The transaction date range is limited to **90 days** by the SimpleFIN server. Historical transactions beyond 90 days are not available.

## Sync examples

```bash
# Sync SimpleFIN (first time — exchanges setup token)
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providers":["simplefin"],"credentials":{"simplefin":{"setupToken":"your-setup-token"}}}'

# Sync SimpleFIN (subsequent — uses persisted access URL)
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providers":["simplefin"],"credentials":{"simplefin":{"accessUrl":"https://user:pass@bridge.simplefin.org/simplefin"}}}'

# Check banking holdings (balances)
curl -X GET http://127.0.0.1:7780/v1/holdings \
  -H "Authorization: Bearer $TOKEN"
```

## Data mapping

| SimpleFIN field | Our type | Mapping |
|-----------------|----------|---------|
| Account `id` | `providerAccountId` | String |
| Account `name` | `name` | Display name |
| Account `currency` | `currency` | ISO code (default `"USD"`) |
| Account `balance` | `cash` (via `getBalances`) | Current balance |
| Transaction `id` | `id` | Unique per transaction |
| Transaction `posted` | `date` | Unix seconds → milliseconds |
| Transaction `amount` ≥ 0 | `type: "credit"` | Deposits, transfers in |
| Transaction `amount` < 0 | `type: "debit"` | Withdrawals, payments |
| Transaction `pending: true` | Excluded | Not imported |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `setup token exchange failed: 403` | Setup token already used | Get a new token from SimpleFIN Bridge dashboard |
| `unexpected response from claim endpoint` | Invalid setup token (not base64) | Verify the token is the full base64 string from the dashboard |
| No accounts returned | SimpleFIN Bridge has no connected accounts | Add bank connections in the SimpleFIN Bridge dashboard |
| `gen.auth` error in errlist | Access URL expired or revoked | Re-run with a new setup token to get a fresh access URL |
