# Coinbase provider

Coinbase is a **crypto-only** provider that connects to the Coinbase Advanced Trade API (v3) using CDP (Coinbase Developer Platform) API keys. Unlike SnapTrade and SimpleFIN, Coinbase credentials are **server-side** — they live in `secrets.json` on the finance-api server, not in the client config.

The Coinbase provider syncs **crypto wallets**, **balances**, **holdings** (with live spot prices), and **trade fills** (buy/sell history). Fiat wallets are synced for cash balances only.

> **Server-side provider.** Credentials live in `~/.pi/sf/finance/secrets.json` on the server, not in the client `config.json`. See [Credentials](#credentials) for the exact format.

## Prerequisites

1. **Create a CDP API key** at [Coinbase](https://www.coinbase.com/) → Settings → API → New API Key (or via the CDP dashboard at [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/)).
2. The key must use a **P-256 (ES256) EC private key**. Coinbase generates the key pair for you, or you can supply your own.
3. Download the private key PEM file — it starts with `-----BEGIN EC PRIVATE KEY-----`.

> ⚠️ **Ed25519 keys are NOT supported.** The Coinbase v3 Advanced Trade API requires ES256 (P-256) keys for JWT authentication. If you create an Ed25519 key, all requests will return `401 Unauthorized`. Make sure to select the P-256 / ES256 key type when creating your API key.

The API key needs **view** permissions only — no trade or transfer permissions are required.

## Credentials

Add your Coinbase credentials to `secrets.json` on the **server** (inside the Docker container or on the native host at `~/.pi/sf/finance/secrets.json`):

```json
{
  "coinbase": {
    "keyName": "organizations/{org_id}/apiKeys/{key_id}",
    "privateKey": "-----BEGIN EC PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEeHAs...\n-----END EC PRIVATE KEY-----"
  }
}
```

| Field | Description |
|-------|-------------|
| `keyName` | The full CDP key name in the format `organizations/{org_id}/apiKeys/{key_id}`. Copy this verbatim from the Coinbase API key page. |
| `privateKey` | The P-256 EC private key in PEM format (`-----BEGIN EC PRIVATE KEY-----`). Include the full key with line breaks. |

**File permissions:** The `secrets.json` file should be mode `0600` (readable only by the owner). The finance-api server enforces this on startup.

```bash
chmod 600 ~/.pi/sf/finance/secrets.json
```

## Authentication

The Coinbase provider authenticates using **ES256 JWT Bearer tokens** — not HMAC signatures or `CB-ACCESS-*` headers. A fresh JWT is minted for every API request (JWTs have a 120-second lifetime).

### JWT structure

**Header:**

```json
{
  "alg": "ES256",
  "kid": "organizations/{org_id}/apiKeys/{key_id}",
  "nonce": "<32 random hex characters>",
  "typ": "JWT"
}
```

**Payload:**

```json
{
  "iss": "cdp",
  "sub": "organizations/{org_id}/apiKeys/{key_id}",
  "nbf": 1700000000,
  "exp": 1700000120,
  "uris": ["GET api.coinbase.com/api/v3/brokerage/accounts"]
}
```

Key details:

- The `uris` claim is an **array** containing a single string: `"<METHOD> api.coinbase.com/api/v3/brokerage<path>"`. The path must be the complete request path including `/api/v3/brokerage` (e.g. `/api/v3/brokerage/accounts` → `"GET api.coinbase.com/api/v3/brokerage/accounts"`).
- The query string is **not** included in the `uris` claim — only the path.
- The `nonce` field is a random 32-hex-character string included in the JWT header for replay protection.
- Each JWT is signed with your EC private key using the ES256 algorithm (ECDSA with P-256 and SHA-256).

**Transport:** The JWT is sent as a standard Bearer token:

```
Authorization: Bearer <jwt>
```

**Implementation:** The finance-api server uses the [`jose`](https://github.com/panva/jose) library (`SignJWT`) and Node.js `createPrivateKey` (which accepts both SEC1 and PKCS8 PEM formats) to mint and sign JWTs.

## What is synced

### Accounts

All Coinbase wallets — crypto and fiat — are synced via `GET /api/v3/brokerage/accounts` with cursor-based pagination (`limit=250` per page, looping while `has_next === true`). Each wallet maps to one account:

| Coinbase field | finance-api field | Transform |
|----------------|-------------------|-----------|
| `uuid` | `providerAccountId` | String (e.g. `"coinbase:a1b2c3..."`) |
| `name` | `name` | Display name; falls back to `"Coinbase <currency>"` |
| `currency` | `currency` | ISO code (e.g. `"BTC"`, `"ETH"`, `"USD"`) |
| `kind` | `kind` | Always `"crypto"` |

Accounts are cached in memory for the duration of a sync, so subsequent `getHoldings` / `getBalances` / `getTransactions` calls avoid redundant network requests.

### Holdings

Holdings are fetched **per-account** (per wallet UUID) from the cached account list. Each wallet produces one `RawHolding`:

| Coinbase field | finance-api field | Transform |
|----------------|-------------------|-----------|
| `currency` | `symbol` | Currency code (e.g. `"BTC"`, `"USDC"`) |
| `available_balance.value` | `quantity` | `Math.abs(Number(value))` — always positive |
| `type` | `assetClass` | Always `"crypto"` |
| Stablecoin set | `cashEquivalent` | `true` for `USD`, `USDC`, `USDT`, `DAI`, `EUR`, `GBP`; `false` otherwise |
| Public price endpoint | `price` | `GET /market/products/{SYMBOL}-USD` → `Number(body.price)` for non-stablecoins only |

**Stablecoins** (`cashEquivalent: true`) are reclassified as `"cash"` by the normalizer, which prevents a doomed `USDC-USD` spot lookup on the price feed.

**Price lookup:** For non-stablecoin crypto holdings (e.g. BTC, ETH), the provider fetches the current spot price from the **public** `GET /api/v3/brokerage/market/products/{SYMBOL}-USD` endpoint. This endpoint is unauthenticated and cached (~1 second). If the price fetch fails (404, network error), the holding is returned without a `price` field — the valuation cascade falls back to `avg_cost` or `0`.

### Balances

Cash balance is derived from the cached account data:

| Coinbase field | finance-api field | Transform |
|----------------|-------------------|-----------|
| `available_balance.value` | `cash` | `Number(value)` when `isFiat(account)` is true; `0` otherwise |
| (hardcoded) | `marketValue` | Always `0` (net worth is computed from holdings) |
| (injected `now()`) | `asOf` | Current timestamp in milliseconds |

**`isFiat` detection:** An account is treated as fiat cash when `type === "ACCOUNT_TYPE_FIAT"` OR the currency is in the stablecoin set (`USD`, `USDC`, `USDT`, `DAI`, `EUR`, `GBP`). This means a USDC wallet typed as `ACCOUNT_TYPE_CRYPTO` still contributes to cash balance.

### Transactions (trade fills only)

⚠️ **Fills-only limitation:** The Coinbase CDP v3 API exposes only **trade fills** (buy/sell history) via `GET /api/v3/brokerage/orders/historical/fills`. Deposits, withdrawals, staking rewards, conversions, send/receive, and other transaction types are **not available** through CDP API keys — they require the v2 OAuth2 authentication path, which CDP keys cannot satisfy.

Each trade fill maps to one `RawTxn`:

| Coinbase field | finance-api field | Transform |
|----------------|-------------------|-----------|
| `entry_id` (or `trade_id`) | `id` | String identifier |
| `trade_time` | `date` | `Date.parse(trade_time)` → milliseconds epoch |
| `product_id` base | `symbol` | `product_id.split("-")[0]` (e.g. `"BTC-USD"` → `"BTC"`) |
| `size` | `qty` | `Math.abs(Number(size))` — always positive |
| `price` | `price` | `Number(price)` — fill price in USD |
| `commission` | `fees` | `Number(commission ?? "0")` |
| `side` | `type` | `"BUY"` → `"credit"`; `"SELL"` → `"debit"` |

**Pagination:** Fills use cursor-based pagination (`limit=100` per page) but differ from accounts: the response contains `{ fills, cursor, proof_token_required }` with **no `has_next` boolean**. The loop continues while `cursor` is non-empty and fills are non-empty, with a hard cap of 50 pages as an infinite-loop guard.

**Account scoping:** The fills endpoint is **account-agnostic** — it returns all fills for the entire portfolio. To scope fills to a specific wallet, the provider filters fills where `product_id`'s base currency matches the wallet's currency. Fiat wallets return `[]` immediately (fills are trade history, not bank transactions).

**`since` filter:** When `since` is provided (milliseconds epoch), the provider:
1. Passes `start_sequence_timestamp=<ISO-8601>` to the server as a query parameter.
2. Applies a **client-side** filter: `Date.parse(trade_time) >= since`. This ensures correctness even if the server parameter name is wrong or ignored.

**Fiat accounts:** Returns `[]` immediately — fills are trade history, not bank transactions.

## Rate limits

| Limit | Value | Notes |
|-------|-------|-------|
| CDP API keys | **10,000 requests per hour** | Per API key; applies to all authenticated endpoints |
| Rate limit response | `429` with body `{"errors":[{"id":"rate_limit_exceeded"}]}` | Standard Coinbase error format |
| Public market data | **~1 second cache** | `GET /market/products/{id}` is unauthenticated and rate-limited |

A typical sync uses ~10–30 requests (accounts list + per-account holdings + fills pagination), well within the hourly limit.

## Sync examples

```bash
# Sync Coinbase
curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providers":["coinbase"]}'

# Verify holdings
curl -X GET http://127.0.0.1:7780/v1/holdings \
  -H "Authorization: Bearer $TOKEN"

# Verify transactions (trade fills)
curl -X GET http://127.0.0.1:7780/v1/history?symbol=BTC \
  -H "Authorization: Bearer $TOKEN"
```

Credentials are read from `secrets.json` on the server — no need to pass them in the request body. See [finance-api](./finance-api) for the full API reference, [SnapTrade](./finance-api-snaptrade) for brokerage aggregation, and [SimpleFIN](./finance-api-simplefin) for banking data.

## Limitations

⚠️ **Fills-only transactions:** The Coinbase CDP v3 API exposes only trade fills (`GET /orders/historical/fills`). The following transaction types are **not available** through CDP API keys:

- Deposits and withdrawals
- Staking rewards
- Conversions (e.g. ETH → ETH2)
- Send and receive (crypto transfers)
- Card spend and rewards

These transaction types require the **v2 OAuth2 authentication** path, which CDP API keys cannot satisfy. If you need full transaction history, consider using the [File Import](./finance-api-file-import) provider with a Coinbase CSV export, or wait for v2 OAuth2 support in a future release.

⚠️ **No cost basis / avgCost:** The CDP v3 API does not provide average cost basis, cost basis, or lot information through the fills endpoint. Imported transactions have no `avgCost` field — net worth calculations use the latest spot price only.

⚠️ **EU SCA (Strong Customer Authentication):** For EU users, the fills endpoint may return `proof_token_required: true` in the response body, indicating that Coinbase requires a proof-of-possession token before releasing fill data. The finance-api provider does **not** implement proof tokens in v1 — the endpoint returns whatever data was provided (typically `[]` empty). This is a known gap.

⚠️ **Watermark caveat:** After each sync, the finance-api server advances the `last_txn_sync_at` watermark for the account. If SCA caused partial fill data to be returned, subsequent syncs will only fetch fills newer than the watermark — older fills that were withheld will not be backfilled automatically.

⚠️ **Duplicate fills across wallets:** The fills endpoint is portfolio-wide. If you have two wallets of the same currency (e.g. two BTC wallets), both will surface the same fills. This is a known limitation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Wrong key type (Ed25519 instead of P-256) | Recreate the API key with **P-256 / ES256** key type |
| `401 Unauthorized` | Expired JWT (clock skew > 120s) | Sync your server's clock (`ntpdate` or equivalent) |
| `401 Unauthorized` | `uris` claim mismatch | Ensure the key format is correct (`organizations/{org_id}/apiKeys/{key_id}`) and the PEM is the matching private key |
| `401 Unauthorized` | Private key format wrong | Ensure the PEM is a valid EC key: `-----BEGIN EC PRIVATE KEY-----` (SEC1) or `-----BEGIN PRIVATE KEY-----` (PKCS8) — both are accepted by createPrivateKey |
| `429 Too Many Requests` | Rate limit exceeded (10,000/hr) | Wait for the rate limit window to reset; reduce sync frequency |
| Empty accounts (`[]`) | No crypto wallets in the Coinbase account | Check that your Coinbase account has wallets; verify you're using the correct organization's API key |
| Missing deposits/withdrawals | Fills-only limitation | CDP v3 keys only expose trade fills. Use [File Import](./finance-api-file-import) with a Coinbase CSV export for deposits and withdrawals |
| Empty transactions despite having trades | EU SCA `proof_token_required` | The fills endpoint may withhold data pending a proof token, which v1 does not implement |
| `coinbase /accounts 500` | Coinbase API outage or invalid credentials | Check [Coinbase status](https://status.coinbase.com/); verify `keyName` and `privateKey` in `secrets.json` |
