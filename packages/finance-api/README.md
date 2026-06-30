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

Some providers authenticate with server-side credentials stored in `~/.pi/sf/finance/secrets.json` (the file is `chmod 600` on creation). **Not every provider uses this file** — SnapTrade, for example, is client-supplied (see its setup below). The table under [Providers](#providers) shows where each provider's credentials live.

```json
{
  "coinbase": {
    "keyName": "your-api-key",
    "privateKey": "your-private-key"
  }
}
```

Each provider's required credentials are documented under [Providers](#providers).

---

## Providers

| Provider | Kind | Auth | Status |
|----------|------|------|--------|
| File Import (CSV/OFX) | brokerage/banking | `filePath` (per-request) | ✅ Working |
| Coinbase | crypto | `keyName` + `privateKey` (in `secrets.json`) | ⚠️ Stub (HMAC not implemented) |
| SnapTrade | brokerage | `clientId` + `consumerKey` (in client `config.json`, passed per-request) | ✅ Working |
| SimpleFIN | banking | `accessKey` (in `secrets.json`) | ⚠️ Stub |
| Teller | banking | `token` (in `secrets.json`) | ⚠️ Stub |

**Provider setup:**

Providers are **co-equal** — you can enable any combination, and multiple providers can run side by side (e.g. SnapTrade for live brokerage sync *and* File Import for a bank OFX export). Each provider is documented on its own page:

- [File Import](#file-import-csvofx) — manual CSV/OFX uploads via `/v1/import`
- [SnapTrade](#snaptrade-setup) — live brokerage aggregation (30+ brokers)

> **⚠️ Cross-provider deduplication is not supported yet.** If the same real-world account surfaces through two providers (e.g. imported via CSV *and* synced via SnapTrade), it appears as **two separate accounts** — there is no mechanism today to recognize and merge them. This is tracked for a future release. For now, use one provider per account to avoid double-counting.

**SimpleFIN / Teller** — Stubs in the current release. Credentials are accepted and validated against the contract, but live API calls are not yet implemented. Tracked for a future release.

### SnapTrade setup

SnapTrade aggregates brokerage accounts (Fidelity, Vanguard, Schwab, Robinhood, and 30+ others) behind a unified API. This integration uses a **Personal API key** — your brokerage connections live under your own SnapTrade Personal account, and identity is resolved from the signed `consumerKey` on every request.

> **v1 supports Personal accounts only.** The Commercial model (`userId`/`userSecret` via `registerSnapTradeUser`) is intentionally not supported.

**Credentials live in the client config** (`~/.pi/sf/finance/config.json`, alongside the service `token`), **not** in the server's `secrets.json`. This keeps one finance-api deployment able to serve different SnapTrade users — each caller passes its own key per request.

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

**Self-provision once** at [snaptrade.com](https://snaptrade.com):
1. Create a **Personal** account.
2. Open the Connection Portal and connect each of your brokerage accounts (Fidelity, Vanguard, Schwab, …). Connections are managed out-of-band on the SnapTrade dashboard — there are no in-service endpoints for it.
3. Copy your Personal `clientId` + `consumerKey` from the dashboard.
4. Add them to the client `config.json` under `providers.snaptrade` as above.

**How a sync works:** SnapTrade is **on-demand only** — the always-on server daemon does not poll SnapTrade on its own (it has no server-side key). Trigger a sync from the `finance` extension:
- `sf_fin_sync_now` (no args) → syncs **all** providers, attaching your Personal SnapTrade key.
- `sf_fin_sync_now({ provider: "snaptrade" })` → syncs **only** SnapTrade.

The client sends `clientId` + `consumerKey` in the request body of `/v1/sync`; the server uses them for that single tick and stores nothing.

**What is synced:** positions (equities/ETFs/mutual funds/crypto — options/futures are out of scope), transactions (incremental, id-keyed — only new activity since the last sync is fetched), and cash balance.

**Polling & rate limits:** each sync serializes accounts; SnapTrade's customer-level limit is 250 requests/minute. A `429` surfaces as a normal ingest error and is retried on the next sync — no special throttling is required for v1.

**Limitations (v1):** short positions are skipped (the data model cannot represent negative quantity); the SnapTrade payee/description field is not captured on transactions; connection management (connect/revoke) happens out-of-band at snaptrade.com. The imported `balance.marketValue` is the SnapTrade-reported **total account value** (cash + positions), not the position-only market value. Only Personal accounts are supported.

---

## File Import (CSV/OFX)

File Import is a co-equal provider that ingests holdings and transactions from manual file uploads via `POST /v1/import`. It covers two formats: CSV (for holdings/positions from any brokerage export) and OFX (for transactions + cash balance from bank exports). This is a good fit for institutions not covered by SnapTrade, or when you prefer not to grant API access.

This section covers everything you need to know — the exact formats accepted, how to export from common brokerages and banks, and what to do when your export isn't directly supported.

### Supported formats

| Format | Extension | Data imported | Use case |
|--------|-----------|---------------|----------|
| CSV | `.csv` | Holdings (positions) | Brokerage exports (any broker that exports a positions CSV) |
| OFX | `.ofx`, `.qfx` | Transactions + balances | Bank exports (checking, savings) |

The service detects the format automatically: `.csv` → positions, OFX → transactions + cash balance.

### CSV format specification

The CSV parser (`src/ingest/file/csv.ts`) expects a **positions-style CSV** — one row per holding, with a header row. The parser is flexible on column names but strict about what data it extracts.

#### Required columns

| Column | Accepted header names (case-insensitive, trimmed) | Example value | Notes |
|--------|---------------------------------------------------|---------------|-------|
| **Symbol** | `symbol` | `AAPL`, `FXAIX`, `VTI` | Must be non-empty. Any string works (no ticker validation). |
| **Quantity** | `quantity`, `shares`, `qty` | `10`, `5.123`, `100` | Must be a non-zero number. Whitespace/symbols stripped (see below). |

#### Optional column

| Column | Accepted header names | Example value | Notes |
|--------|----------------------|---------------|-------|
| **Price** | `last price`, `price` | `190.50`, `$3,450.00` | If absent, holdings import with no avg cost. **Stored as `avgCost`, not "last price".** The net-worth endpoint uses the latest price from the prices table, not this value. |

#### How numeric values are parsed

Every numeric field (quantity, price) goes through exactly this transformation:

```
cols[idx].replace(/[^0-9.\-]/g, "")  →  Number(...)  →  Math.abs() (quantity only)
```

This strips **everything** except digits (`0-9`), dot (`.`), and hyphen (`-`). Then:
- **Quantity is forced positive** via `Math.abs()`. A value of `-10` becomes `10`. Short positions cannot be imported.
- **Price preserves its sign** (no `abs`), but negative prices are meaningless.

| Input | After stripping | After `Number()` | Final (qty with `abs`) |
|--------|-----------------|-------------------|------------------------|
| `$1,234.56` | `1234.56` | `1234.56` | `1234.56` |
| `10` | `10` | `10` | `10` |
| `5.123` | `5.123` | `5.123` | `5.123` |
| `(190.50)` | `190.50` | `190.50` | `190.50` ⚠️ |
| `-10` | `-10` | `-10` | `10` ⚠️ |

> ⚠️ **Accounting-style negatives like `(190.50)` are silently parsed as positive.** Parentheses are stripped by the regex. If your CSV uses parentheses for negative values, replace them with a minus sign before importing.

> ⚠️ **Negative quantities become positive.** If your export uses `-10` for short positions, the parser forces it to `10`. Short positions are not currently supported.

#### Known parser limitations

1. **No quoted-field support.** The parser uses `split(",")` — any comma inside a value (e.g., `"Apple, Inc."` as a description column) will break the column alignment. **Remove commas from text fields** before importing, or ensure your export doesn't include them.

2. **`assetClass` is always `"equity"`.** All CSV-imported holdings are tagged as equity. There is no way to import bonds, cash, or crypto via CSV. The `subclass` is always `"us"` (the `EQUITY_HINTS` regex is effectively dead code — both branches return `"us"`).

3. **Any column beyond the 3 recognized ones is ignored.** Extra columns like `Description`, `Account`, `Last Price Change`, `Cost Basis` are silently discarded.

4. **Empty/zero-quantity rows are silently skipped.** If a row has an empty symbol or a zero/NaN quantity, it's dropped with no warning. A CSV with only a header and no data rows returns `[]`.

#### Minimum valid CSV

```csv
Symbol,Quantity
AAPL,10
FXAIX,5.123
```

#### Fully specified CSV (typical brokerage export)

```csv
Account,Symbol,Description,Quantity,Last Price
Brokerage,AAPL,Apple Inc.,10,190.50
Brokerage,VTI,Total Stock Market,5.123,180.00
```

Most brokerages export positions with a header row like `Account,Symbol,Description,Quantity,Last Price` (sometimes `Shares` instead of `Quantity`, or `Price` instead of `Last Price`). The parser accepts all of these.

### OFX format specification

The OFX parser (`src/ingest/file/ofx.ts`) supports standard OFX 1.x / QFX files (the format used by most banks for transaction downloads).

#### What the parser extracts

| XML element | Mapped to | Default if absent |
|-------------|-----------|-------------------|
| `<ACCTID>` | Account ID | `"unknown"` |
| `<BALAMT>` | Cash balance | `0` |
| `<STMTTRN>` → `<TRNAMT>` | Transaction amount | `0` |
| `<STMTTRN>` → `<DTPOSTED>` | Transaction date (YYYYMMDD or YYYYMMDDHHMMSS) | unix epoch `0` (1970-01-01) |
| `<STMTTRN>` → `<NAME>` | Payee name (parsed by `parseOfx`) | `""` (empty) |

#### What reaches the API response

The file adapter (`src/ingest/file/index.ts`) transforms the parsed OFX data before it reaches the API:

| Field | Parser layer | Adapter layer (API response) |
|-------|-------------|------------------------------|
| Balance → `RawBalance` | `parseOfx().balance` | `{ cash: balance, marketValue: 0, asOf: timestamp }` — treated as cash |
| Transactions → `RawTxn[]` | `parseOfx().transactions` | `{ id: "${arrayIndex}", date: unixMs, type: "credit"\|"debit", fees: 0 }` |
| Payee (`<NAME>`) | ✅ Parsed by `parseOfx` | ❌ **Discarded** — not present in API response |
| Fees | Not parsed | Hardcoded to `0` |
| Symbol/quantity | N/A | N/A — OFX imports transactions, not holdings |

> ⚠️ **`.qfx` detection is by content (OFXHEADER literal), not by extension.** The parser detects OFX when the file has a `.ofx` extension OR when the file content contains the literal string `OFXHEADER` (which standard `.qfx` exports always include). A `.qfx` file without `OFXHEADER` would not import.

> ⚠️ **OFX holdings are always empty.** OFX is for banking transactions. To import positions (stocks/ETFs), use CSV.

#### Date parsing

OFX dates are parsed as `YYYYMMDD` or `YYYYMMDDHHMMSS`. If the date string is empty or shorter than 8 characters, the date defaults to unix epoch `0` (displayed as `1970-01-01`). In practice this never happens with real OFX exports.

#### Detection

- The file adapter checks for `.ofx` extension for the initial routing (in `getHoldings`).
- Files containing the literal string `OFXHEADER` anywhere in the content are treated as OFX (in `getTransactions` and `getBalances`; this is how `.qfx` files work — they always contain `OFXHEADER`).
- A file without `.ofx` extension AND without `OFXHEADER` content will not be parsed as OFX.

> ⚠️ **The payee name (`<NAME>`) is parsed from the OFX file but discarded by the adapter.** Imported transactions have no payee/description field. This is a known gap.

### How to export from your brokerage

The CSV parser accepts any positions export with a `Symbol` column and a `Quantity`/`Shares`/`Qty` column (an optional `Last Price`/`Price` column is read as average cost). The exact menu path varies by brokerage, but the steps are the same everywhere:

1. **Log into your brokerage's website** and navigate to your Portfolio / Positions / Holdings page.
2. **Select the account** you want to export.
3. **Look for Download / Export** — typically a down-arrow icon or a link near the positions table header.
4. **Choose CSV format** (not PDF, not Excel).
5. **Save the file** — it typically downloads as `Positions_<date>.csv` or similar.
6. **Check the headers** — you need `Symbol` and one of `Quantity`/`Shares`/`Qty`. A `Last Price`/`Price` column is optional. Extra columns (Description, Account, Cost Basis, …) are ignored.
7. **Import the file:**
   ```bash
   curl -X POST http://127.0.0.1:7780/v1/import \
     -H "Authorization: Bearer $(cat ~/.pi/sf/finance/token)" \
     -H "Content-Type: application/json" \
     -d '{"filePath":"/Users/me/Downloads/positions.csv"}'
   ```
8. **Verify the import worked:**
   ```bash
   curl -X GET http://127.0.0.1:7780/v1/holdings \
     -H "Authorization: Bearer $(cat ~/.pi/sf/finance/token)"
   ```

> **Tip:** The price column (`Last Price` or `Price`) is stored as `avgCost` on the holding — the `/v1/net-worth` endpoint computes value using the latest price from the price feed, not this field. So a missing or stale price column is harmless.
>
> **Prefer live sync?** If your brokerage is one of the 30+ supported by SnapTrade (Fidelity, Vanguard, Schwab, Robinhood, …), [SnapTrade](#snaptrade-setup) gives you automatic live sync with no manual exports.

### Exports that need adjustment

Some institutions export data in a shape the CSV parser can't read directly. This is not an exhaustive list — the same patterns apply to any similar export.

#### Crypto exchanges (e.g. Coinbase)

**Reason:** Crypto exchanges export **transaction history**, not portfolio positions. A typical CSV has columns like:

```
Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price,Subtotal,Total,Notes
```

There is no `Symbol` column (the parser's required key). Even if renamed, the data represents *transactions* (buys/sells/transfers), not *current holdings*. The parser would need significant changes to aggregate transactions into a portfolio snapshot.

**What you can do today:**
1. Manually create a CSV with `Symbol,Quantity` columns from your exchange balances.
2. Get your current balances from the exchange UI (Dashboard → each asset → balance).
3. Write a CSV like:
   ```csv
   Symbol,Quantity
   BTC,0.05
   ETH,2.0
   ```
4. Import with `POST /v1/import`.

**Future:** A direct Coinbase API aggregator stub (`src/ingest/direct/coinbase.ts`) is planned for a future release. When implemented, it will pull positions directly via API key (HMAC-signed).

#### Banks (e.g. Bank of America)

**Reason:** Banks export **account activity** (transactions), not portfolio positions. A typical bank CSV has columns like:

```
Date,Description,Amount,Running Bal.
```

No `Symbol` column. No `Quantity` column. The data is a transaction ledger, not a position list.

**What you can do today:**
- **OFX/QFX:** Most banks support OFX download (via "Download Transactions" → choose "Microsoft Money" or "Quicken" format). This is the **recommended path** — the OFX parser handles these files correctly for transaction history and cash balance.
  ```bash
  curl -X POST http://127.0.0.1:7780/v1/import \
    -H "Authorization: Bearer $(cat ~/.pi/sf/finance/token)" \
    -H "Content-Type: application/json" \
    -d '{"filePath":"/Users/me/Downloads/bank-activity.ofx"}'
  ```
- **For positions** held in a bank's investing arm (e.g. Merrill Edge for BoA), download a positions export from the investment section — these typically follow the `Symbol,Quantity,Last Price` format the parser accepts.
- **Live sync:** If the brokerage side is supported by SnapTrade, [SnapTrade](#snaptrade-setup) gives you automatic sync.

#### If your CSV doesn't match

Most brokerages export positions with `Symbol`, `Quantity`/`Shares`, and optionally a `Last Price`/`Price` column. If your export has these columns under any accepted header name, it will import. If the import returns empty holdings, check that your CSV has `Symbol` and `Quantity`/`Shares`/`Qty` in the header row (`head -1 your-file.csv`).

### curl examples

**Import CSV (holdings):**
```bash
curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/absolute/path/to/positions.csv"}'
```

**Import OFX (transactions):**
```bash
curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/absolute/path/to/transactions.ofx"}'
```

**Verify after import:**
```bash
# Check holdings
curl -X GET http://127.0.0.1:7780/v1/holdings \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check net worth (uses latest prices, not CSV avg costs)
curl -X GET http://127.0.0.1:7780/v1/net-worth \
  -H "Authorization: Bearer YOUR_TOKEN"

# Trigger a full sync (recompute suggestions from new data)
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Troubleshooting imports

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `{"ok":false,"error":{"code":"bad_request","message":"Missing filePath"}}` | No `filePath` in the JSON body | Add `"filePath": "/path/to/file.csv"` to your request body |
| `{"ok":false,"error":{"code":"bad_request","message":"Directory traversal is not allowed"}}` | Relative path contains `..` (e.g., `../../data.csv`) | Use an **absolute** path (`/Users/me/...`) or a relative path without `..` (`./data.csv`) — absolute paths are always allowed |
| Import succeeds but holdings are empty (`[]`) | CSV is missing `Symbol` or `Quantity`/`Shares`/`Qty` column in the header, or all rows have zero/empty quantities | Check your CSV header row — it must contain one of the accepted column names. Run `head -1 your-file.csv` to inspect |
| Imported quantities are wrong | CSV uses `(value)` for negatives (accounting convention) or `-value` for short positions | Short/negative quantities cannot be imported — `Math.abs()` forces all quantities positive. No workaround in the current parser. Remove negative rows or accept them as positive.
| Import succeeds but prices are wrong or missing | CSV has no `Last Price`/`Price` column, or the column has non-numeric characters the regex can't parse | Add a missing price column or accept that holdings import with no avg cost; the net-worth endpoint uses a separate price feed |
| Comma in description breaks the parse | `split(",")` splits on commas inside quoted values (e.g., `"Apple, Inc."`) | Remove commas from all text fields before importing, or export without description columns |
| Imported OFX transactions have date `1970-01-01` | OFX date field is missing or malformed (`<DTPOSTED>` empty or `< 8 chars`) | Verify the OFX file is valid — real bank exports always include dates. If this happens, the file may be corrupted |
| Imported OFX transactions have no merchant name | Payee `<NAME>` is parsed by `parseOfx` but discarded by the adapter | This is a known limitation — transaction descriptions are not persisted. Tracked for a future release |
| `401 Unauthorized` on import | Token is missing or wrong | Retrieve the token: `cat ~/.pi/sf/finance/token` (native) or `docker compose exec finance-api cat /root/.pi/sf/finance/token` (Docker). Include `Authorization: Bearer <token>` in your request |

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
  { "id": "snaptrade:acct-1", "provider_id": "snaptrade", "kind": "brokerage", "name": "Brokerage",
    "holdings": [ { "account_id": "snaptrade:acct-1", "symbol": "AAPL", "quantity": 10, "asset_class": "equity", "as_of": 1782000000000 } ] }
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

Trigger a scheduler tick: ingest from providers, refresh prices, recompute suggestions.

**Optional request body:**

| Field | Type | Description |
|-------|------|-------------|
| `providers` | `string[]` | Scope ingest to a subset of providers (e.g. `["snaptrade"]`). Omit to ingest from all configured providers. |
| `credentials` | `object` | Per-provider credentials supplied per-call (request creds override server-side `secrets.json` creds for this tick; nothing is persisted). Used for Personal SnapTrade keys. |

Example — sync SnapTrade with a per-call Personal key:

```bash
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providers":["snaptrade"],"credentials":{"snaptrade":{"clientId":"PERS-...","consumerKey":"..."}}}'
```

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

**Request body:** `{ "filePath": "/Users/me/Downloads/positions.csv" }`

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
| Stale holdings | Run `POST /v1/sync`; check provider credentials (SnapTrade → client `config.json`, others → `secrets.json`) |
| `better-sqlite3` build fails (native) | Use the Docker image, or ensure `python3 make g++` are installed |
| No suggestions after sync | Set a goal via `POST /v1/goals` — drift/rebalance need a target |

---

## Cost

- **Free tier:** File imports (CSV/OFX) and `stooq` prices — no API costs.
- **Optional:** Coinbase API (free, view-only scope) — currently a stub.
- **SnapTrade:** live brokerage aggregation (Fidelity, Vanguard, Schwab, Robinhood, 30+ others — see [SnapTrade setup](#snaptrade-setup)).
- **Optional:** SimpleFIN / Teller aggregators (may have fees) — currently stubs.

---

## Disclaimer

**This is not financial advice.** The service provides deterministic calculations based on your data and configured goals. Suggestions are informational only — no trades are executed automatically. Always consult a qualified financial advisor before making investment decisions.

## License

[MIT](../../LICENSE)
