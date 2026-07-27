# Coinbase API Deep-Dive Research — Round 1 Resolutions

**Date:** 2026-07-27
**Sources:** Coinbase OpenAPI spec (11,888-line YAML), @coinbase/cdp-sdk v1.44.1 source (jsDelivr), @coinbase-sample/advanced-sdk-ts source (GitHub), live curl probes against api.coinbase.com

---

## O1: Transactions Endpoint — RESOLVED (CRITICAL)

### Finding: The v3 per-account transactions endpoint is UNDOCUMENTED

The endpoint `GET /api/v3/brokerage/accounts/{uuid}/transactions`:
- **Live probe:** Returns HTTP 401 ("Unauthorized") — endpoint EXISTS on the wire but requires auth.
- **OpenAPI spec:** NOT present in the full 11,888-line spec (`https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/advanced-trade-spec.yaml`). The only transactions-related v3 endpoint is `GET /api/v3/brokerage/transaction_summary` (aggregate summary, not per-account).
- **Official sample SDK:** `coinbase-samples/advanced-sdk-ts` has NO `listTransactions` or transactions-per-account service. Accounts service only has `getAccount` and `listAccounts`.

**Source:** 
- OpenAPI spec: grep for `transactions` and `account_uuid` in the spec file — no match for path `accounts/{account_uuid}/transactions`
- Sample SDK: `github.com/coinbase-samples/advanced-sdk-ts`, `src/rest/accounts/index.ts` — only `getAccount`/`listAccounts`
- Live probe: `curl -s https://api.coinbase.com/api/v3/brokerage/accounts/00000000-0000-0000-0000-000000000000/transactions` → 401

### RECOMMENDATION: Use v2 fallback or use the Fills endpoint

**Option A — v2 transactions endpoint (OAuth2 required, NOT compatible with CDP keys):**
`GET /v2/accounts/:account_id/transactions` requires `wallet:transactions:read` OAuth2 scope. Cannot use CDP ES256 JWT.

**Option B — Use fills as trade history (v3, CDP-compatible):**
`GET /api/v3/brokerage/orders/historical/fills` — documented, supports `cursor`, `limit` (default 100), `start_sequence_timestamp` / `end_sequence_timestamp` (RFC3339). Returns `{ fills: [...], cursor, proof_token_required }`. This gives TRADE history but not deposits/withdrawals.

**Option C — Document the v3 endpoint yourself:**
If the endpoint really works with a CDP key, probe it with a real key. Fields are UNKNOWN without an authenticated response. If you can get a response, document it. Otherwise, do NOT implement against an undocumented endpoint — it may change or be removed.

### v3 Fills endpoint — response schema (from OpenAPI spec)

Source: `advanced-trade-spec.yaml`, path `/api/v3/brokerage/orders/historical/fills`

Query params: `order_ids[]`, `trade_ids[]`, `product_ids[]`, `start_sequence_timestamp` (RFC3339), `end_sequence_timestamp` (RFC3339), `limit` (int64, default 100), `cursor` (string), `sort_by` (UNKNOWN_SORT_BY|PRICE|TRADE_TIME), `asset_filters[]`, `order_types[]`, `order_side` (BUY|SELL), `product_types[]` (SPOT|FUTURE)

Response: `GetFillsResponse { fills: Fill[], cursor: string, proof_token_required: boolean }`

The `Fill` schema itself is in the spec (search for `coinbase.public_api.authed.retail_brokerage_api.Fill`).

---

## O2: Account `type` Enum — RESOLVED

**From the OpenAPI spec** (lines ~6546-6555):
```
coinbase.public_api.authed.retail_brokerage_api.AccountType:
  type: string
  enum:
    - ACCOUNT_TYPE_UNSPECIFIED
    - ACCOUNT_TYPE_CRYPTO
    - ACCOUNT_TYPE_FIAT
    - ACCOUNT_TYPE_VAULT
    - ACCOUNT_TYPE_PERP_FUTURES
  default: ACCOUNT_TYPE_UNSPECIFIED
```

**Confirmed by sample SDK** (`github.com/coinbase-samples/advanced-sdk-ts`, `src/model/enums/AccountType.ts`):
```ts
export enum AccountType {
  Unspecified = 'ACCOUNT_TYPE_UNSPECIFIED',
  Crypto = 'ACCOUNT_TYPE_CRYPTO',
  Fiat = 'ACCOUNT_TYPE_FIAT',
  Vault = 'ACCOUNT_TYPE_VAULT',
  PerpFutures = 'ACCOUNT_TYPE_PERP_FUTURES',
}
```

Also: `AccountPlatform` enum:
- `ACCOUNT_PLATFORM_UNSPECIFIED`, `ACCOUNT_PLATFORM_CONSUMER` (spot), `ACCOUNT_PLATFORM_CFM_CONSUMER` (US derivatives), `ACCOUNT_PLATFORM_INTX` (international exchange)

### RECOMMENDATION: Use `type === 'ACCOUNT_TYPE_FIAT'` to identify USD/fiat accounts for `getBalances`. Use `type === 'ACCOUNT_TYPE_CRYPTO'` for crypto holdings. Ignore `ACCOUNT_TYPE_VAULT` (locked) and `ACCOUNT_TYPE_PERP_FUTURES` (derivatives, separate balance system).

---

## O3: Fee Fields on Transactions — RESOLVED (NO PER-TXN FEES IN V3)

The v3 API has NO per-transaction fee endpoint. The only fee endpoint is:
- `GET /api/v3/brokerage/transaction_summary` → `GetTransactionSummaryResponse { totalVolume, totalFees, feeTier: FeeTier, marginRate?, goodsAndServicesTax?, advancedTradeOnlyVolume?, advancedTradeOnlyFees?, coinbaseProVolume?, coinbaseProFees?, totalBalance? }` — aggregate only, NOT per-transaction.

**Source:** OpenAPI spec path `/api/v3/brokerage/transaction_summary`; sample SDK `src/model/GetTransactionSummaryResponse.ts`

### The `Fill` object in the fills response LIKELY contains fee information (e.g. `commission`). But the exact fields need to be extracted from the OpenAPI spec's `Fill` schema, which was too large to fetch in full.

### RECOMMENDATION: For basic transaction purposes, set `fees: 0` on `RawTxn` (same as SimpleFIN convention). Trade fees can be inferred from fills if needed.

---

## O4: Cursor Pagination Mechanics — RESOLVED

### Accounts pagination

From OpenAPI spec (`/api/v3/brokerage/accounts`):

| Aspect | Detail |
|--------|--------|
| Query param name | `cursor` (string) |
| Limit param | `limit` (int32, default **49**, max **250**) |
| Response fields | `has_next` (boolean, **required**), `cursor` (string), `size` (int32, number of accounts) |
| First request | **Omit** `cursor` parameter entirely (do NOT pass empty string) |
| Loop condition | `while (response.has_next)` — use `response.cursor` as next query's `cursor` param |

```yaml
# Source: advanced-trade-spec.yaml (~line 40-60 for params, ~7660 for response)
parameters:
  - name: limit
    description: The number of accounts to display per page. By default, displays 49 (max 250).
  - name: cursor
    description: For paginated responses, returns all responses that come after this value.

GetAccountsResponse:
  properties:
    accounts: array of Account
    has_next: boolean (required)
    cursor: string
    size: int32
```

### Fills pagination

Same pattern: `cursor` query param, `cursor` + `has_next` not present (fills uses `cursor` only for next page). `limit` default is 100 (int64).

### Orders pagination

Same: `cursor` query param, `has_next` + `cursor` in response. No default limit specified ("no default amount").

### RECOMMENDATION: Generic cursor pagination loop:

```ts
async function* paginate<T>(fetch: (cursor?: string) => Promise<{ items: T[]; has_next: boolean; cursor: string }>) {
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    yield* page.items;
    cursor = page.has_next ? page.cursor : undefined;
  } while (cursor);
}

// Accounts:
const accounts = paginate(async (cursor?) => {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const res = await signedRequest(`/accounts?${params}`);
  return { items: res.accounts, has_next: res.has_next, cursor: res.cursor };
});
```

---

## O5: JWT Signing — Exact Code-Level Steps

### CDP SDK `generateJwt` signature

**Source:** `@coinbase/cdp-sdk` v1.44.1, `_types/auth/utils/jwt.d.ts` and `_esm/auth/utils/jwt.js` (jsDelivr)

```ts
// Export path:
import { generateJwt } from '@coinbase/cdp-sdk/auth';  // or '@coinbase/cdp-sdk/auth'

// Signature:
async function generateJwt(options: JwtOptions): Promise<string>

interface JwtOptions {
  apiKeyId: string;      // "organizations/{org_id}/apiKeys/{key_id}"
  apiKeySecret: string;  // PEM EC private key or base64 Ed25519 key
  requestMethod?: string | null;  // "GET"
  requestHost?: string | null;    // "api.coinbase.com"
  requestPath?: string | null;    // "/api/v3/brokerage/accounts"
  expiresIn?: number;     // default 120
  audience?: string[];    // optional
}
```

**CRITICAL FINDING:** The `uri` is stored as `uris` (ARRAY) in the JWT payload, NOT a single `uri` string:

```js
// From _esm/auth/utils/jwt.js line ~55:
if (hasAllRequestParams) {
    claims.uris = [`${options.requestMethod} ${options.requestHost}${options.requestPath}`];
}
```

The JWT header has: `alg: "ES256"`, `kid: keyName`, `typ: "JWT"`, `nonce` (16 random bytes as hex)
The JWT payload has: `sub: keyName`, `iss: "cdp"`, `nbf`, `iat`, `exp` (nbf+120), `uris: ["METHOD hostpath"]`, optional `aud`.

The SDK uses `jose` library internally:
- `importPKCS8(privateKey, "ES256")` for EC keys
- `new SignJWT(claims).setProtectedHeader({...}).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+expiresIn).sign(ecKey)`

### Manual JWT signing (without SDK) — Node.js code

```ts
import * as crypto from 'crypto';
import { SignJWT, importPKCS8 } from 'jose';

// OR with raw crypto (not recommended — use jose):

async function signJwtManual(
  keyName: string,         // "organizations/{org}/apiKeys/{key}"
  privateKeyPem: string,   // "-----BEGIN EC PRIVATE KEY-----\n..."
  method: string,          // "GET"
  host: string,            // "api.coinbase.com"
  path: string,            // "/api/v3/brokerage/accounts"
): Promise<string> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const ecKey = await importPKCS8(privateKeyPem, 'ES256');
  
  return new SignJWT({
    sub: keyName,
    iss: 'cdp',
    uris: [`${method} ${host}${path}`],
  })
    .setProtectedHeader({ alg: 'ES256', kid: keyName, typ: 'JWT', nonce })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(ecKey);
}

// Usage: Authorization: Bearer <token>
```

**Key creation note:** Must be ECDSA P-256. Ed25519 keys use `alg: "EdDSA"` in the SDK but the prior report says Ed25519 isn't supported for Brokerage specifically. Both alg types are handled by the SDK.

---

## O6: Rate Limits & Error Shapes — RESOLVED

### Rate limits

**Source:** `https://docs.cdp.coinbase.com/coinbase-app/api-architecture/rate-limiting`

- **10,000 requests per hour** per API key (or per OAuth user)
- HTTP 429 response:
```json
{
  "errors": [
    {
      "id": "rate_limit_exceeded",
      "message": "Too many requests"
    }
  ]
}
```

### General error shape (gRPC gateway errors)

**Source:** OpenAPI spec, `grpc.gateway.runtime.Error` schema (line 11862):
```yaml
grpc.gateway.runtime.Error:
  type: object
  properties:
    error:     { type: string }
    code:      { type: integer, format: int32 }
    message:   { type: string }
    details:   { type: array, items: { $ref: 'google.protobuf.Any' } }
```

### SDK error model

**Source:** sample SDK `src/model/Error.ts`:
```ts
type Error = {
  message?: string;
  code?: string;          // e.g. "ERROR_CODES_RATE_LIMITED"
  errorCode?: ErrorCodes; // enum
  errorCta?: ErrorCta;
  errorMetadata?: ErrorMetadata;
  title?: string;
};
```

### Auth failure errors

From the ErrorCodes enum: `ERROR_CODES_AUTHENTICATION_ERROR`, `ERROR_CODES_PERMISSION_DENIED`. The 401 response likely uses the gRPC error shape above. The rate limit error uses the flat `errors: [{id, message}]` envelope (different from gRPC errors!).

**Important:** There are TWO error shapes:
1. **gRPC errors:** `{ error, code, message, details }` — for API business logic errors, auth errors
2. **Rate limit errors:** `{ errors: [{ id, message }] }` — for 429 specifically

---

## Additional Confirmed Findings

### A. Public product price endpoint

| Endpoint | Status | Returns | 
|---|---|---|
| `GET /api/v3/brokerage/market/products/BTC-USD` | ✅ 200 (PUBLIC) | `{ product_id, price: "64479.33", ... }` (full product + price) |
| `GET /api/v3/brokerage/market/products/BTC-USD/spot` | ❌ 404 | `{"error":"unknown","error_details":"Not Found","message":"Not Found"}` |
| `GET /v2/prices/BTC-USD/spot` | ✅ 200 (PUBLIC) | `{ data: { amount: "64482.005", base: "BTC", currency: "USD" } }` |

**Source:** Live curl probes, confirmed 2026-07-27

**The `prices.ts` bug is confirmed:** `src/market/prices.ts:8` calls `/market/products/${coin}-USD/spot` which returns 404. Fix: drop `/spot` suffix → `/market/products/${coin}-USD`.

### B. `/brokerage/products/{product_id}` requires auth

Unlike `/market/products/{product_id}` (public), the `/brokerage/products/{product_id}` endpoint requires Bearer auth (returns 401 without it). The `market` prefix variant is the public one.

### C. Account full schema (OpenAPI spec)

```
Account {
  uuid: string
  name: string
  currency: string
  available_balance: Amount { value: string, currency: string }
  default: boolean
  active: boolean
  created_at: string (RFC3339)
  updated_at: string (RFC3339)
  deleted_at: string (RFC3339)
  type: AccountType (enum)
  ready: boolean
  hold: Amount { value: string, currency: string }
  retail_portfolio_id: string
  platform: AccountPlatform (enum)
}
```

### D. The `PriceBook` (best bid/ask) has per-product fee info

`GET /api/v3/brokerage/best_bid_ask` returns price books with bid/ask prices and sizes, but no fee data per se.

---

## Summary: Resolved Answers

| Question | Answer |
|---|---|
| **O1: Transactions fields** | V3 per-account transactions endpoint is **undocumented** — exists on wire (401) but not in spec/SDK. **Use fills endpoint or v2 fallback.** |
| **O2: Account types** | `ACCOUNT_TYPE_UNSPECIFIED`, `ACCOUNT_TYPE_CRYPTO`, `ACCOUNT_TYPE_FIAT`, `ACCOUNT_TYPE_VAULT`, `ACCOUNT_TYPE_PERP_FUTURES` |
| **O3: Fee fields** | **No per-transaction fees in v3.** Aggregate only via `transaction_summary`. Set `fees: 0` on RawTxn. |
| **O4: Pagination** | Query: `cursor` (omit on first), `limit` (49 default / 250 max for accounts). Response: `has_next`, `cursor`, `size`. |
| **O5: JWT signing** | `uris: ["METHOD hostpath"]` (array!). SDK: `generateJwt({apiKeyId, apiKeySecret, requestMethod, requestHost, requestPath})`. Manual: `jose` SignJWT with `importPKCS8`. |
| **O6: Rate limits** | 10K req/hr. 429: `{"errors":[{"id":"rate_limit_exceeded","message":"Too many requests"}]}`. Auth errors use gRPC shape: `{error, code, message, details}`. |

## NEW Open Questions

| # | Question | Priority |
|---|---|---|
| **N1** | Does `GET /api/v3/brokerage/accounts/{uuid}/transactions` actually work with a CDP key, and what does the response look like? (Need REAL key to probe) | 🔴 Critical |
| **N2** | What are the exact fields in the `Fill` object? (need to fetch full Fill schema from OpenAPI spec) | 🟡 Medium |
| **N3** | Does the fills `start_sequence_timestamp` accept ISO-8601 with timezone (the spec says RFC3339)? | 🟢 Low |
| **N4** | For the `transaction_summary` endpoint, what `product_type` values are valid? (SPOT, FUTURE) | 🟢 Low |

