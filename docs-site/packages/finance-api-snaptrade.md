# SnapTrade provider

SnapTrade aggregates 30+ brokerage accounts (Fidelity, Vanguard, Schwab, Robinhood, …) behind a unified API. This integration uses a **Personal API key** — your brokerage connections live under your own SnapTrade Personal account, and identity is resolved from the signed `consumerKey` on every request. Scope is **data-sync only**.

> **v1 supports Personal accounts only.** The Commercial model (`userId`/`userSecret` via `registerSnapTradeUser`) is intentionally not supported. One finance-api deployment can serve different SnapTrade users because each caller passes its own key per request.

## Credentials

Credentials live in the **client config** on the machine where you run pi (`~/.pi/sf/finance/config.json` on **your workstation**, not the finance-api server), **not** in the server's `secrets.json`. The `finance` extension sends them in the body of each `/v1/sync` request; the server uses them for that single tick and stores nothing.

| Field | What it is | Where it comes from |
|-------|------------|---------------------|
| `clientId` | Personal client ID | SnapTrade Personal dashboard |
| `consumerKey` | Personal secret (never sent on the wire; used to HMAC-sign requests) | SnapTrade Personal dashboard |

```json
{
  "apiUrl": "http://127.0.0.1:7780",
  "token": "<service bearer token>",
  "providers": {
    "snaptrade": {
      "clientId": "PERS-...",
      "consumerKey": "<your personal consumer key>"
    }
  }
}
```

## Connect your brokerages (one-time)

1. Create a **Personal** account at [snaptrade.com](https://snaptrade.com).
2. Open the Connection Portal from the SnapTrade dashboard and connect each of your brokerage accounts (Fidelity, Vanguard, Schwab, …). Connections are managed on the dashboard — there are no in-service endpoints for it.
3. Copy your Personal `clientId` + `consumerKey` from the dashboard.
4. Add them to the client `config.json` under `providers.snaptrade` as above.

> Never expose `consumerKey` to a browser/client you don't control. The finance extension is the only consumer that should read it.

## Triggering a sync

SnapTrade is **on-demand only** — the always-on server daemon does not poll SnapTrade on its own (it has no server-side key). Trigger a sync from the `finance` extension:

- `sf_fin_sync_now` (no args) → syncs **all** providers, attaching your Personal SnapTrade key.
- `sf_fin_sync_now({ provider: "snaptrade" })` → syncs **only** SnapTrade.

Under the hood the client sends `clientId` + `consumerKey` in the request body of `/v1/sync`:

```bash
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providers":["snaptrade"],"credentials":{"snaptrade":{"clientId":"PERS-...","consumerKey":"..."}}}'
```

## What gets synced

| Data | Behavior |
|------|----------|
| Positions | Equities, ETFs, mutual funds, crypto. Options/futures are out of scope (v1). |
| Transactions | Incremental: only new activity since the last sync is fetched (`startDate` watermark), upserted by SnapTrade transaction `id`. |
| Cash balance | Latest snapshot per account (USD entry preferred). |

## Limitations

- **Personal accounts only** — the Commercial `userId`/`userSecret` flow is not supported.
- **On-demand sync** — there is no background polling; SnapTrade refreshes only when a client calls `/v1/sync` with credentials.
- **Short positions are skipped** — the data model cannot represent negative quantity.
- **Connection management is out-of-band** — connect/revoke happen on the SnapTrade dashboard.
- SnapTrade transaction descriptions/payees are not captured in v1.
- The imported `balance.marketValue` is the SnapTrade-reported **total account value** (cash + positions), not the position-only market value.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Sync returns 0 accounts | Verify `clientId` + `consumerKey` are present in the client `config.json` under `providers.snaptrade`; the client attaches them per-request. |
| Account shows `stale_at` / never updates | The brokerage connection may be broken — reconnect it on the SnapTrade dashboard. |
| `429` / throttled | Customer limit is 250 req/min; the next sync retries automatically. |
| Missing positions | Only `units > 0` positions import; shorts and zero-share rows are skipped. |

See the [finance-api page](./finance-api) for the HTTP API and [File Import](./finance-api-file-import) for CSV/OFX alternatives.
