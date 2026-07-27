# Coinbase Provider — Exhaustive Codebase Implementation Map

**Date:** 2026-07-27
**Scope:** Every file:line citation needed to implement Coinbase correctly, mirroring existing patterns.

---

## 1. Current Stub: `packages/finance-api/src/ingest/direct/coinbase.ts`

File is 36 lines. Every line analyzed:

### 1.1 Imports & types (L1–6)

`import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";`
— `src/ingest/direct/coinbase.ts:1`. Standard pattern. No change needed.

`const BASE = "https://api.coinbase.com/api/v3/brokerage";`
— `src/ingest/direct/coinbase.ts:3`. Correct base URL. No change needed.

`interface FetchLike { (url: string, init?: RequestInit): Promise<Response> }`
— `src/ingest/direct/coinbase.ts:5`. Simple type for injectable fetcher. Must be preserved to allow test mocking. Pattern matches `simplefin.ts:6` but simpler (simplefin uses `typeof fetch` directly).

`export interface CoinbaseDeps { fetcher?: FetchLike; now?: () => number }`
— `src/ingest/direct/coinbase.ts:6`. Same DI pattern as simplefin's `SimplefinAdapterDeps` (`src/ingest/aggregator/simplefin.ts:8`). **Must be preserved** — this is the contract that lets tests inject mock fetchers.

### 1.2 Factory function (L8–10)

`export function createCoinbaseAdapter(deps: CoinbaseDeps = {}): ProviderAdapter {`
  const fetcher = deps.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
— `src/ingest/direct/coinbase.ts:8-10`. Standard factory pattern. `now` is injectable; used for timestamp generation. **Must be preserved.**

### 1.3 signedRequest — FAKE (L12–21)

`async function signedRequest(creds: Credentials, path: string): Promise<unknown> {`
  const timestamp = Math.floor(now() / 1000).toString();
  // Real signing uses HMAC-SHA256 over timestamp+method+path+body with privateKey.
  // This stub passes keyName as CB-ACCESS-KEY; full HMAC signing added when wiring real creds.
  const res = await fetcher(`${BASE}${path}`, {
    headers: {
      "CB-ACCESS-KEY": creds.keyName,
      "CB-ACCESS-TIMESTAMP": timestamp,
    },
  });
  if (!res.ok) throw new Error(`coinbase ${path} ${res.status}`);
  return res.json();
— `src/ingest/direct/coinbase.ts:12-21`.

**WHAT'S WRONG:**
- L14: `CB-ACCESS-KEY` / `CB-ACCESS-TIMESTAMP` is the **legacy Coinbase Pro/Exchange HMAC auth** — not CDP API key auth.
- No actual HMAC computation. No `CB-ACCESS-SIGN` header. No `CB-ACCESS-PASSPHRASE` header. The comment says "HMAC-SHA256" but zero HMAC is computed.
- No `Authorization: Bearer <jwt>` header — the CDP standard.
- L19: Does throw on non-2xx — this pattern is CORRECT and matches `simplefin.ts:92` (`if (!res.ok) throw new Error(...)`). **Preserve this pattern.**

**MUST BE REPLACED WITH:**
- ES256 JWT signing: one JWT per request. Header: `{ alg: "ES256", kid: keyName, nonce: randomHex(32), typ: "JWT" }`. Payload: `{ iss: "cdp", sub: keyName, nbf: now_s, exp: now_s + 120, uri: "GET api.coinbase.com<path>" }`.
- Sign with Node.js `crypto.sign(null, jwtPayload, privateKeyPem)` using `SHA256` digest.
- Transport: `Authorization: Bearer <jwt>`.
- No `@coinbase/cdp-sdk` or `jose` is installed (see §12 below). Must use raw `node:crypto`.

### 1.4 authenticate — WORKS, needs JWT (L23–25)

`authenticate: async (creds: Credentials): Promise<Session> => {`
  if (!creds.keyName || !creds.privateKey) throw new Error("coinbase requires keyName + privateKey");
  return { providerId: "coinbase", creds };
— `src/ingest/direct/coinbase.ts:23-25`.

**CORRECT.** The Session shape with `{ providerId, creds }` matches the `simplefin.ts:84-89` pattern. The validate-throw pattern matches simplefin L85-86. **No structural change needed.** However, JWT signing will be invoked per-request, not during authenticate.

### 1.5 listAccounts — FAKE (L26)

`listAccounts: async (_s: Session): Promise<RawAccount[]> =>`
  [{ providerAccountId: "spot", kind: "crypto", name: "Coinbase Spot", currency: "USD" }],
— `src/ingest/direct/coinbase.ts:26`.

**WHAT'S WRONG:**
- Returns a single hardcoded account — no API call at all.
- `providerAccountId: "spot"` is not a real Coinbase UUID.

**MUST:**
- Call `GET /api/v3/brokerage/accounts` via `signedRequest`.
- Paginate: loop while `has_next === true`, passing `cursor` param. Default `limit` is 49, max 250.
- Map each `{ uuid, name, currency }` → `RawAccount { providerAccountId: uuid, kind: "crypto", name: name ?? "Coinbase " + currency, currency }`.
- Cache the response (WeakMap keyed on Session) — see simplefin pattern §2.4 below.

### 1.6 getHoldings — BUG (L27–32)

`getHoldings: async (s: Session): Promise<RawHolding[]> => {`
  const creds = s.creds ?? {};
  const body = (await signedRequest(creds, "/accounts")) as { accounts?: { currency: string; available_balance?: { value: string } }[] };
  return (body.accounts ?? [])
    .filter((a) => a.currency !== "USD")
    .map((a) => ({ symbol: a.currency, quantity: Number(a.available_balance?.value ?? "0"), assetClass: "crypto" }));
— `src/ingest/direct/coinbase.ts:27-32`.

**WHAT'S WRONG:**
1. **Signature ignores `accountId`** — the `ProviderAdapter` contract (`src/ingest/contract.ts:21`) specifies `getHoldings(s: Session, accountId: string): Promise<RawHolding[]>`. The stub's parameter list is `(s: Session)` — missing `accountId`. **This is a type error.**
2. **Fetches all accounts** (`/accounts` instead of `/accounts/{accountId}`) — wrong scope.
3. **Keys on `currency`** instead of UUID — the `getHoldings(s, "a1")` call should fetch holdings for uuid `"a1"`, not all BTC balances.
4. **Filters out USD** but misses stablecoins (USDC, USDT, DAI). These should be kept but flagged as `cashEquivalent: true`.

**MUST:**
- Signature: `getHoldings: async (s: Session, accountId: string): Promise<RawHolding[]>`
- Fetch: `GET /api/v3/brokerage/accounts/{accountId}` → `account.available_balance`
- Map: `{ symbol: currency, quantity: Math.abs(Number(available_balance.value)), assetClass: "crypto", cashEquivalent: isStable(currency) }`
- Add `isStable()` helper: `new Set(["USD","USDC","USDT","DAI"])`
- Optionally fetch price from public endpoint for non-stablecoins (see §10 pre-existing bug)

### 1.7 getTransactions — EMPTY STUB (L33)

`getTransactions: async (): Promise<RawTxn[]> => [],`
— `src/ingest/direct/coinbase.ts:33`.

**WHAT'S WRONG:**
- Returns `[]` always. No API call. Missing `session`, `accountId`, and `since` parameters.

**MUST:**
- Signature: `getTransactions: async (s: Session, accountId: string, since?: number): Promise<RawTxn[]>`
- Fetch: `GET /api/v3/brokerage/accounts/{accountId}/transactions` with cursor pagination.
- If `since` is a number, add `start_date = new Date(since).toISOString()` query param.
- Map: `{ id: t.id, date: Date.parse(t.created_at), type: Number(t.amount.amount) >= 0 ? "credit" : "debit", fees: t.fees ?? 0, symbol: t.amount.currency, qty: Math.abs(Number(t.amount.amount)) }`
- Date conversion critical: Coinbase returns ISO-8601 strings → `Date.parse(iso)` gives ms-epoch. **Do NOT use `*1000`** — that's for epoch-seconds (SimpleFIN pattern, `simplefin.ts:137`).

### 1.8 getBalances — EMPTY STUB (L34)

`getBalances: async (): Promise<RawBalance> => ({ cash: 0, marketValue: 0, asOf: now() }),`
— `src/ingest/direct/coinbase.ts:34`.

**WHAT'S WRONG:**
- Always returns `cash: 0`. Missing `session` and `accountId` parameters.

**MUST:**
- Signature: `getBalances: async (s: Session, accountId: string): Promise<RawBalance>`
- For USD/fiat accounts: `cash = Number(available_balance.value)`. For crypto accounts: `cash = 0`.
- Always `marketValue: 0` — matches `simplefin.ts:108` (`marketValue: 0`) and confirmed by `value.ts:51` which computes net worth via holdings, not `balance.market_value`.
- `asOf: Date.now()` — matches simplefin pattern.

---

## 2. Reference Implementation: `packages/finance-api/src/ingest/aggregator/simplefin.ts`

Every reusable pattern extracted:

### 2.1 Injectable dependencies (L1, L8–9)

`import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";`
— `src/ingest/aggregator/simplefin.ts:1`.

`export interface SimplefinAdapterDeps {`
  fetcher?: typeof fetch;
`}`
— `src/ingest/aggregator/simplefin.ts:8-9`.

**Pattern:** Exported interface with optional `fetcher`/`now`. Tests inject `vi.fn()`.
**Coinbase already has this** (`src/ingest/direct/coinbase.ts:5-6`). **Preserve.**

### 2.2 Factory + DI resolution (L74–75)

`export function createSimplefinAdapter(deps: SimplefinAdapterDeps = {}): ProviderAdapter {`
  const fetcher = deps.fetcher ?? fetch;
— `src/ingest/aggregator/simplefin.ts:74-75`.

**Pattern:** Default to real `fetch` if not injected. Coinbase already does this at L9–10. **Preserve.**

### 2.3 WeakMap caching keyed on Session (L77–79)

`const balanceCache = new WeakMap<object, AccountSet>();`
`const txnCache = new WeakMap<object, AccountSet>();`
— `src/ingest/aggregator/simplefin.ts:77-79`.

**Pattern:** Cache API responses per Session so `getBalances`/`getTransactions` don't re-fetch. The Session object (`{ providerId, creds }`) is stable per ingest run, making WeakMap viable. Key is `object` (Session).

**Coinbase MUST adopt this** for:
- `listAccounts` → store full accounts response cached by Session
- `getHoldings` → can use cached account data (or fetch per-uuid if not cached)
- `getTransactions` → cache the full bulk response if pagination is single-call

### 2.4 resolvedCreds → creds resolution (L56–58)

`function resolveAccessUrl(s: Session): string {`
  return s.resolvedCreds?.accessUrl ?? s.creds?.accessUrl ?? "";
`}`
— `src/ingest/aggregator/simplefin.ts:56-58`.

**Pattern:** `session.resolvedCreds` (set by `authenticate`) takes precedence over `session.creds` (attached by `runIngest`). Falls back to empty/default.

**Coinbase relevance:** Not directly applicable (no token exchange). But the pattern of `s.creds ?? {}` at `coinbase.ts:28` is the correct threading — `runIngest` attaches creds to session at `registry.ts:31`: `session = { ...session, creds: c }`.

### 2.5 authenticate pattern (L82–89)

`authenticate: async (creds: Credentials): Promise<Session> => {`
  if (creds.accessUrl) { return { providerId: "simplefin", creds }; }
  if (creds.setupToken) {
    const accessUrl = await exchangeSetupToken(creds.setupToken, fetcher);
    return { providerId: "simplefin", creds, resolvedCreds: { accessUrl } };
  }
  throw new Error("simplefin requires setupToken or accessUrl");
`},`
— `src/ingest/aggregator/simplefin.ts:82-89`.

**Pattern:** Validate required creds → return Session. Optionally set `resolvedCreds` for token exchange flows.
**Coinbase equivalent** at `coinbase.ts:23-25` is correct (validate keyName + privateKey). No token exchange needed.

### 2.6 listAccounts pattern (L91–101)

`listAccounts: async (s: Session): Promise<RawAccount[]> => {`
  const { baseUrl, auth } = parseAccessUrl(resolveAccessUrl(s));
  const res = await fetcher(`${baseUrl}/accounts?balances-only=1&version=2`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`simplefin: /accounts returned ${res.status}`);
  const data: AccountSet = await res.json();
  checkErrlist(data);
  balanceCache.set(s, data);  // <-- CACHE
  return (data.accounts ?? []).map((acct) => ({
    providerAccountId: String(acct.id),
    kind: "banking" as const,
    name: acct.name ?? "simplefin account",
    currency: acct.currency ?? "USD",
  }));
`},`
— `src/ingest/aggregator/simplefin.ts:91-101`.

**Critical elements:**
1. Throw on non-2xx (L93). Same as `coinbase.ts:19`.
2. Cache response (L94). **Coinbase must do this.**
3. Map with fallbacks for name/currency (L98-99). **Coinbase must do similar.**

### 2.7 getHoldings — returns [] (L103)

`getHoldings: async (): Promise<RawHolding[]> => [],`
— `src/ingest/aggregator/simplefin.ts:103`.

**Pattern:** Banking adapters have no equity holdings → return `[]`.
**Coinbase:** Must return actual crypto holdings per UUID. Different from this.

### 2.8 getBalances pattern (L105–113)

`getBalances: async (s: Session, accountId: string): Promise<RawBalance> => {`
  const cached = balanceCache.get(s);
  if (!cached) return { cash: 0, marketValue: 0, asOf: Date.now() };
  const acct = (cached.accounts ?? []).find((a) => String(a.id) === accountId);
  if (!acct) return { cash: 0, marketValue: 0, asOf: Date.now() };
  return {
    cash: Number(acct.balance ?? 0),
    marketValue: 0,
    asOf: acct["balance-date"] ? acct["balance-date"] * 1000 : Date.now(),
  };
`},`
— `src/ingest/aggregator/simplefin.ts:105-113`.

**Critical elements:**
1. `marketValue: 0` — **always**. This is the universal pattern. COINBASE MUST FOLLOW THIS.
2. Uses cached `listAccounts` response (WeakMap). COINBASE MUST CACHE for this.
3. Graceful fallback to `{ cash: 0, marketValue: 0, asOf: Date.now() }` on cache miss / unknown account.
4. `asOf` from provider data if available, else `Date.now()`.

**Coinbase equivalent:**
- For USD/fiat account: `cash = Number(available_balance.value)`.
- For crypto account: `cash = 0`.
- Always `marketValue: 0`.

### 2.9 getTransactions pattern (L115–137)

`getTransactions: async (s: Session, accountId: string, _since?: number): Promise<RawTxn[]> => {`
  let cached = txnCache.get(s);
  if (!cached) {
    const { baseUrl, auth } = parseAccessUrl(resolveAccessUrl(s));
    const res = await fetcher(`${baseUrl}/accounts?version=2`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`simplefin: /accounts returned ${res.status}`);
    const fresh: AccountSet = await res.json();
    checkErrlist(fresh);
    txnCache.set(s, fresh);
    cached = fresh;
  }
  const acct = (cached.accounts ?? []).find((a) => String(a.id) === accountId);
  if (!acct?.transactions) return [];
  return acct.transactions
    .filter((t) => !t.pending)
    .map((t) => ({
      id: String(t.id),
      date: t.posted ? t.posted * 1000 : 0,
      type: Number(t.amount) >= 0 ? "credit" : "debit",
      fees: 0,
    }));
`},`
— `src/ingest/aggregator/simplefin.ts:115-137`.

**Critical elements:**
1. **Cache the full response** (L117, L127) — one HTTP call for all accounts. This works for SimpleFIN because it returns all accounts in one response. For Coinbase v3, each account has its own `/transactions` endpoint, so caching strategy differs.
2. **Date conversion: `t.posted * 1000`** — SimpleFIN returns epoch-seconds, so multiply by 1000 to get ms-epoch. **COINBASE IS DIFFERENT:** Coinbase returns ISO-8601 strings → use `Date.parse(created_at)` directly (gives ms-epoch). Do NOT multiply.
3. **`type: Number(t.amount) >= 0 ? "credit" : "debit"`** — L134. **COINBASE MUST FOLLOW THIS EXACT CONVENTION.** The amount is a signed string; sign determines credit/debit.
4. **Pending filter** (L133) — filter `!t.pending`. Coinbase v3 may have a `status` field; filter to `"COMPLETED"` only.
5. **`fees: 0`** as default (L136). Coinbase may provide `fees` field — use if available, else `0`.

---

## 3. `packages/finance-api/src/ingest/contract.ts` — Full Interface

File is 24 lines.

### 3.1 Types (L1–7)

`export type ProviderKind = "brokerage" | "retirement" | "banking" | "crypto";`
— `src/ingest/contract.ts:1`.

Coinbase's kind is `"crypto"` — already set correctly at `coinbase.ts:23` (returned object has `kind: "crypto"` in the top-level returned adapter).

`export interface Credentials { [key: string]: string }`
— `src/ingest/contract.ts:3`.

Generic key-value string map. Coinbase uses `{ keyName, privateKey }`.

`export interface Session { providerId: string; expiresAt?: number; creds?: Credentials; resolvedCreds?: Credentials }`
— `src/ingest/contract.ts:4`.

Coinbase returns `{ providerId: "coinbase", creds }` at L25 — correct. No `resolvedCreds` needed (no token exchange).

### 3.2 RawAccount (L6)

`export interface RawAccount { providerAccountId: string; kind: ProviderKind; name: string; maskLast4?: string; currency: string }`
— `src/ingest/contract.ts:6`.

- `providerAccountId` — Coinbase: `uuid` from API
- `kind` — always `"crypto"` for Coinbase
- `name` — Coinbase `name` field, fallback `"Coinbase " + currency`
- `maskLast4` — not available from Coinbase, leave undefined
- `currency` — Coinbase `currency` field

### 3.3 RawHolding (L7–9)

`export interface RawHolding {`
  symbol: string; quantity: number; avgCost?: number; assetClass: string; subclass?: string;
  price?: number; securityType?: string; cashEquivalent?: boolean;
  lots?: { openDate: number; qty: number; costBasis: number }[];
`}`
— `src/ingest/contract.ts:7-9`.

Coinbase mapping:
- `symbol` — currency (e.g. `"BTC"`)
- `quantity` — `Math.abs(Number(available_balance.value))` — **must be non-negative** (normalizer throws at `normalizer.ts:11`)
- `avgCost` — not available from Coinbase → omit
- `assetClass` — `"crypto"`
- `cashEquivalent` — `true` for USD, USDC, USDT, DAI (stablecoins)
- `price` — optionally from public `/market/products/{SYMBOL}-USD`
- `lots` — not available → omit

### 3.4 RawTxn (L10)

`export interface RawTxn { id: string; date: number; symbol?: string; qty?: number; price?: number; type: string; fees?: number }`
— `src/ingest/contract.ts:10`.

Coinbase mapping:
- `id` — transaction id (string)
- `date` — `Date.parse(created_at)` → ms epoch
- `symbol` — `amount.currency`
- `qty` — `Math.abs(Number(amount.amount))`
- `type` — `Number(amount.amount) >= 0 ? "credit" : "debit"`
- `fees` — fee field if available, else `0`

### 3.5 RawBalance (L11)

`export interface RawBalance { cash: number; marketValue: number; asOf: number }`
— `src/ingest/contract.ts:11`.

Coinbase mapping:
- `cash` — `Number(available_balance.value)` for USD/fiat; `0` for crypto
- `marketValue` — always `0` (see §7)
- `asOf` — `Date.now()`

### 3.6 ProviderAdapter interface (L13–22)

`export interface ProviderAdapter {`
  readonly kind: ProviderKind;
  readonly providerId: string;
  authenticate(creds: Credentials): Promise<Session>;
  listAccounts(s: Session): Promise<RawAccount[]>;
  getHoldings(s: Session, accountId: string): Promise<RawHolding[]>;
  getTransactions(s: Session, accountId: string, since?: number): Promise<RawTxn[]>;
  getBalances(s: Session, accountId: string): Promise<RawBalance>;
`}`
— `src/ingest/contract.ts:13-22`.

**CRITICAL:** `getHoldings`, `getTransactions`, and `getBalances` all take `(s: Session, accountId: string, ...)`. The current coinbase stub violates this at L27, L33, L34 where `accountId` is missing from the parameter list.

---

## 4. `packages/finance-api/src/ingest/registry.ts` — The runIngest Flow

File is 108 lines.

### 4.1 Account ID format (L35)

`const id = \`${providerId}:${acc.providerAccountId}\`;`
— `src/ingest/registry.ts:35`.

**Coinbase IDs:** `coinbase:{uuid}` — e.g. `coinbase:abc-123-def`. UUID comes from Coinbase API.

### 4.2 Transaction watermark mechanics (L83–101)

`const lastSync = getTxnWatermark(db, id);`
— `src/ingest/registry.ts:85`.

`const txns = await adapter.getTransactions(session, acc.providerAccountId, lastSync ?? undefined);`
— `src/ingest/registry.ts:87`.

`setTxnWatermark(db, id, Date.now());`
— `src/ingest/registry.ts:100`.

**Critical facts:**
1. **`lastSync` is ms-epoch** (stored in `accounts.last_txn_sync_at` column, `repo.ts:58-60` returns `number | null`).
2. **First sync: `lastSync` is `null` → `undefined` passed as `since`.** Adapter must handle `undefined` correctly (don't add `start_date` param).
3. **Watermark advances to `Date.now()` AFTER getTransactions returns** — even if the API returned a partial page or errored mid-loop. **GOTCHA G4:** Partially fetched pages may never backfill. Mitigation: fetch a wider window or only advance on full completion.
4. **Transaction fetch failures are NON-FATAL** — they're caught at L102-104 and logged but don't stop the ingest. Balance fetch failures are also non-fatal (L107-109).

### 4.3 Fatal vs non-fatal failures

| Failure | Fatal? | Behavior |
|---------|--------|----------|
| `authenticate` throws | **Yes** (L22-27) | Provider skipped, `errors++` |
| `listAccounts` throws | **Yes** (L110-113) | All accounts for provider skipped, `errors++` |
| `getHoldings` throws for one account | **No** (L76-79) | Account marked stale, `errors++`, continues to next account |
| Individual holding normalize throws | **No** (L65-67) | That holding skipped, logged |
| `getTransactions` throws for one account | **No** (L102-104) | Logged, continues |
| Individual txn upsert throws | **No** (L95-97) | That txn skipped, logged |
| `getBalances` throws for one account | **No** (L107-109) | Logged, continues |

### 4.4 Session creds threading (L31)

`session = { ...session, creds: c };`
— `src/ingest/registry.ts:31`.

`runIngest` attaches the original `Credentials` object to the session. This is how `s.creds ?? {}` at `coinbase.ts:28` gets populated. **All adapters follow this pattern.**

### 4.5 resolvedCreds propagation (L32–34)

`if (session.resolvedCreds) {`
  resolvedCredentials[providerId] = session.resolvedCreds;
  hasResolved = true;
`}`
— `src/ingest/registry.ts:32-34`.

If `authenticate` sets `resolvedCreds`, they're propagated to the caller (e.g., SimpleFIN access URL exchange). **Coinbase does not need this** — no credential exchange.

---

## 5. `packages/finance-api/src/ingest/normalizer.ts` — Normalizer Behavior

File is 21 lines (function body).

### 5.1 Negative quantity → throw (L11)

`if (raw.quantity < 0) throw new Error(\`negative quantity for ${raw.symbol}\`);`
— `src/ingest/normalizer.ts:11`.

**Coinbase must ensure `Math.abs()` before passing to normalizer.** Coinbase `available_balance.value` can be negative (debit balance); always `Math.abs(Number(value))`.

### 5.2 Quantity rounding (L12)

`const rounded = Math.round(raw.quantity * 1e6) / 1e6;`
— `src/ingest/normalizer.ts:12`.

Precision: 6 decimal places. Applies to all holdings. **Coinbase doesn't need special handling.**

### 5.3 cashEquivalent → "cash" override (L16)

`const assetClass = raw.cashEquivalent === true ? "cash" : raw.assetClass;`
— `src/ingest/normalizer.ts:16`.

**This is the stablecoin pattern.** Set `cashEquivalent: true` on USDC, USDT, DAI, and USD holdings so the normalizer reclassifies them as `"cash"`. This prevents a doomed `CRYPTO:USDC` price lookup (there's no `USDC-USD` market product on Coinbase).

Verified by test at `tests/normalizer.test.ts:18-23`.

### 5.4 Canonical symbol (L28)

`symbol: canonicalSymbol(raw.symbol, assetClass),`
— `src/ingest/normalizer.ts:28`.

Calls `canonicalSymbol` from `src/store/symbols.ts`. Crypto assetClass → `CRYPTO:` prefix. This happens AFTER the `cashEquivalent` → `"cash"` override, so stablecoins get no prefix (kept as plain `"USDC"` with asset_class `"cash"`).

---

## 6. `packages/finance-api/src/store/symbols.ts` — Crypto Prefix Logic

File is 10 lines.

### 6.1 CRYPTO_PREFIX (L1)

`export const CRYPTO_PREFIX = "CRYPTO:";`
— `src/store/symbols.ts:1`.

### 6.2 canonicalSymbol (L3–6)

`export function canonicalSymbol(rawSymbol: string, assetClass: string): string {`
  const s = rawSymbol.trim().toUpperCase();
  if (assetClass === "crypto") return `${CRYPTO_PREFIX}${s}`;
  return s;
`}`
— `src/store/symbols.ts:3-6`.

**Coinbase:** BTC → `CRYPTO:BTC`, ETH → `CRYPTO:ETH`, etc. This is what the prices table stores and what `fetchClose` expects.

### 6.3 isCrypto (L8–10)

`export function isCrypto(symbol: string): boolean {`
  return symbol.startsWith(CRYPTO_PREFIX);
`}`
— `src/store/symbols.ts:8-10`.

Used by `prices.ts:8` to route to Coinbase price endpoint.

---

## 7. `packages/finance-api/src/valuation/value.ts` — Price Cascade

File is 78 lines.

### 7.1 Price priority (L27)

`const price = latestPrice(db, h.symbol) ?? h.price ?? h.avg_cost ?? 0;`
— `src/valuation/value.ts:27`.

**Priority:**
1. `latestPrice` (from prices table — most recent market data)
2. `h.price` (provider-supplied price at sync time)
3. `h.avg_cost` (cost basis — last resort)
4. `0`

**Coinbase implications:**
- If Coinbase provides `price` on `RawHolding` (from public market endpoint), it fills slot 2.
- If the `prices` table has data (from `fetchClose`), it takes precedence.
- `0` is a valid explicit price; `??` only falls through on `null`/`undefined`.

### 7.2 computeNetWorth ignores balance.market_value (L50–53)

`export function computeNetWorth(db: Database.Database): { netWorth: number; accountCount: number } {`
  const accounts = listAccounts(db);
  const holdingsValue = valueHoldings(db).reduce((sum, h) => sum + h.marketValue, 0);
  const unbilledCash = accounts.reduce((sum, a) => sum + computeUnbilledCash(db, a.id), 0);
  return { netWorth: holdingsValue + unbilledCash, accountCount: accounts.length };
`}`
— `src/valuation/value.ts:50-53`.

**`balance.market_value` is NEVER used** in net worth calculation. Only `balance.cash` is used (in `computeUnbilledCash`). This confirms `marketValue: 0` on `getBalances` is safe and correct.

---

## 8. `packages/finance-api/src/ingest/secrets.ts` + Secrets Path

File is 33 lines.

### 8.1 loadSecrets (L9–18)

`export function loadSecrets(secretsPath: string): IngestCreds {`
  try {
    const raw = readFileSync(secretsPath, "utf8");
    return JSON.parse(raw) as IngestCreds;
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT") {
      return {};
    }
    throw e;
  }
`}`
— `src/ingest/secrets.ts:9-18`.

### 8.2 saveSecrets (L24–27)

`export function saveSecrets(secretsPath: string, creds: IngestCreds): void {`
  writeFileSync(secretsPath, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(secretsPath, 0o600); } catch { /* best effort */ }
`}`
— `src/ingest/secrets.ts:24-27`.

### 8.3 Secrets path

Default: `~/.pi/sf/finance/secrets.json` — from `src/config/load.ts:15`:
`secretsPath: path.join(dir, "secrets.json"),`

### 8.4 Coinbase credential shape

Per README (`README.md:110`):
```
| Coinbase | crypto | `keyName` + `privateKey` (in `secrets.json`) | ⚠️ Stub (HMAC not implemented) |
```

Expected secrets.json entry:
```json
{
  "coinbase": {
    "keyName": "organizations/{org_id}/apiKeys/{key_id}",
    "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----"
  }
}
```

File is `chmod 600`. Credentials are `{ [key: string]: string }` (`IngestCreds` = `{ [providerId: string]: Credentials }`).

### 8.5 keyName format

Must be: `organizations/{org_id}/apiKeys/{key_id}` — this is both the JWT `kid` header and `sub` claim.

### 8.6 privateKey format

PEM EC private key (`-----BEGIN EC PRIVATE KEY-----`). Curve: **P-256 / ES256**. Ed25519 keys are NOT supported for the Brokerage API.

---

## 9. `packages/finance-api/src/ingest/matrix.ts` — Registration

File is 14 lines.

`export function buildDefaultRegistry(): AdapterRegistry {`
  return new Map([
    ["fidelity", createFileAdapter("fidelity", "brokerage")],
    ["boa", createFileAdapter("boa", "banking")],
    ["coinbase", createCoinbaseAdapter()],        // <-- L7: ALREADY REGISTERED
    ["snaptrade", createSnaptradeAdapter()],
    ["simplefin", createSimplefinAdapter()],
    ["boa-teller", createTellerAdapter()],
  ]);
`}`
— `src/ingest/matrix.ts:2-10`.

**Coinbase is already registered at L7.** No change needed. The `createCoinbaseAdapter()` call is parameterless — the implementation must work without requiring deps.

---

## 10. `packages/finance-api/src/market/prices.ts` — The 404 Bug

File is 34 lines.

### 10.1 The bug (L8–9)

`if (symbol.startsWith(CRYPTO_PREFIX)) {`
  const coin = symbol.slice(CRYPTO_PREFIX.length);
  const res = await fetcher(`https://api.coinbase.com/api/v3/brokerage/market/products/${coin}-USD/spot`, {});
— `src/market/prices.ts:8-10`.

**THE BUG:** `/market/products/${coin}-USD/spot` returns **HTTP 404**. The `/spot` suffix is incorrect for the v3 Brokerage API.

Correct endpoint: `/market/products/${coin}-USD` (no `/spot` suffix).

Response: `{ price: "64503.04" }` — parsed at L12:
`const body = (await res.json()) as { price: string };`
  return Number(body.price);
— `src/market/prices.ts:11-12`.

This parsing is correct; only the URL is wrong.

### 10.2 Impact

This is a **pre-existing bug** — not caused by the Coinbase adapter. It blocks crypto price lookups for ALL sources (not just Coinbase holdings). `fetchClose("CRYPTO:BTC")` → 404.

### 10.3 Context in prices.test.ts

The test at `tests/prices.test.ts:11-17` passes because it mocks the fetcher — it doesn't actually hit the endpoint. The real endpoint call fails with 404.

### 10.4 Fix needed

Change L10 from:
`/market/products/${coin}-USD/spot`
To:
`/market/products/${coin}-USD`

Or add a fallback to v2: `GET /v2/prices/${coin}-USD/spot` → `{ data: { amount, base, currency } }`.

---

## 11. `packages/finance-api/tests/coinbase.test.ts` — Current Test

File is 16 lines. Single test.

### 11.1 The test

`describe("coinbase adapter", () => {`
  it("maps Coinbase accounts response to RawHolding[]", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      accounts: [{ uuid: "a1", currency: "BTC", available_balance: { value: "1.5", currency: "BTC" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createCoinbaseAdapter({ fetcher: fetcher as never });
    const session = await adapter.authenticate({ keyName: "k", privateKey: "s" });
    const holdings = await adapter.getHoldings(session, "ignored");
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ symbol: "BTC", quantity: 1.5, assetClass: "crypto" });
  });
`});`
— `tests/coinbase.test.ts:1-16`.

### 11.2 What's wrong

1. **L12:** `adapter.getHoldings(session, "ignored")` — passes `"ignored"` as accountId. The stub ignores it. This test **validates the bug**.
2. **L5-7:** Mock returns `{ accounts: [...] }` (list format). After the fix, `getHoldings` will fetch `/accounts/{uuid}` which returns `{ account: {...} }` (single account format). Mock format must change.
3. **No JWT auth assertion.** The mock intercepts at the `fetcher` level so headers are invisible. After the fix, should verify `Authorization: Bearer` header.

### 11.3 What must change

| Current | After Fix |
|---------|-----------|
| Mock: `{ accounts: [...] }` | Mock: `{ account: { uuid: "a1", currency: "BTC", available_balance: { value: "1.5", currency: "BTC" } } }` |
| `getHoldings(session, "ignored")` | `getHoldings(session, "a1")` — UUID matters |
| Asserts `accounts` response mapping | Asserts per-uuid `account` response mapping |
| No auth header check | Verify `Authorization: Bearer <jwt>` header |
| One test | Multiple tests: pagination, stablecoin, transactions, balances |

### 11.4 How the fetcher mock works

Uses vitest's `vi.fn()` returning `new Response(...)`. Same pattern as `simplefin.test.ts:46` (`mockFetcher` helper). Tests are hermetic — no network calls. Vitest `^4.0.0` at root (`package.json:18`), run with `pnpm test` from root or `vitest run` from package dir.

---

## 12. `packages/finance-api/package.json` — Dependencies

File is 42 lines.

### 12.1 No JWT/crypto libraries installed

**CONFIRMED:** `grep` for `jose|@coinbase/cdp|ES256|generateJwt` returned **zero matches** across the entire `packages/finance-api` directory.

Available dependencies:
- `@hono/node-server`, `@hono/swagger-ui`, `@hono/zod-openapi`
- `@pi-stef/paths`
- `@sinclair/typebox`
- `better-sqlite3`
- `hono`
- `snaptrade-typescript-sdk`
- `tsx`
- `zod`

**No crypto library. No JWT library. No `jose`. No `@coinbase/cdp-sdk`.**

### 12.2 What's available for ES256 JWT signing

Node.js built-in `crypto` module (from `@types/node` at root). Used elsewhere:
- `src/server/bootstrap.ts:2`: `import { randomUUID } from "node:crypto";`
- `src/server/auth.ts:1`: `import { timingSafeEqual } from "node:crypto";`

**ES256 signing options:**
- Use `crypto.createSign("SHA256")` for raw EC signing
- Install `jose` (lightweight, zero-dep) — adds a dependency
- Install `@coinbase/cdp-sdk` — heavyweight, pulls in many deps
- **Recommendation:** Use `crypto.subtle` (Web Crypto API, available in Node 19+, target ES2022 from `tsconfig.base.json:3`). Import from `node:crypto`.

### 12.3 Vitest version

Root `package.json:18`: `"vitest": "^4.0.0"`. No local vitest in finance-api's `package.json` — inherits from root.

### 12.4 Scripts

```
"test": "vitest run",
"typecheck": "tsc --noEmit -p tsconfig.json",
"serve": "tsx bin/finance-api.ts"
```
— `packages/finance-api/package.json:29-33`.

**No `build` or `lint` script** at this package level. Root has `"typecheck": "tsc -b"`.

### 12.5 Monorepo

`pnpm-workspace.yaml:1-2`: `packages: ["packages/*"]`. pnpm version: `10.31.0` (root `package.json:5`).

### 12.6 Module system

`"type": "module"` — both at root and finance-api. `tsconfig.base.json` has `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"target": "ES2022"`.

---

## 13. Test Infrastructure

### 13.1 Test runner

Vitest `^4.0.0` at root. Config at `/Users/stefano/Projects/pi-stef/vitest.config.ts`:
```ts
test: {
  include: ["packages/*/tests/**/*.test.ts", "scripts/**/*.test.{ts,js,mjs}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
},
```

### 13.2 Hermetic tests

**All provider tests are hermetic.** They mock `fetcher` via `vi.fn()` returning `new Response(...)`. **Zero network calls** in test suite.

Simplefin tests use a helper (`simplefin.test.ts:45`):
```ts
function mockFetcher(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}
```

This pattern should be extracted to a shared test helper. Coinbase test currently inlines it at L6-8.

### 13.3 No shared test fixtures

No `tests/helpers.ts` or `tests/fixtures/` directory exists. Each test file is self-contained. The `mockFetcher` pattern is repeated across tests. Coinbase test currently inlines it.

### 13.4 Ingest integration tests

`tests/ingest.test.ts` uses `openDb(":memory:")` for SQLite. Tests flow through `runIngest` with fake adapters. **Coinbase should have similar integration tests** (per the SimpleFIN pattern at `simplefin.test.ts:161-183` which tests `runIngest` integration).

### 13.5 Running tests

```bash
# From monorepo root:
pnpm test                    # all packages
pnpm --filter @pi-stef/finance-api test   # just finance-api
# From package dir:
vitest run                   # all tests
vitest run tests/coinbase    # just coinbase
```

---

## Summary: Implementation-Critical Facts & Patterns to Mirror

### A. Reusable SimpleFIN Patterns

| Pattern | simplefin.ts location | Coinbase implementation |
|---------|----------------------|------------------------|
| Injectable `fetcher`/`now` deps | L1-9, L74-75 | Already have (`coinbase.ts:5-10`) — **preserve** |
| Throw on non-2xx | L93 | Already have (`coinbase.ts:19`) — **preserve** |
| WeakMap caching per Session | L77-79 | **MUST ADD** for listAccounts response |
| `type: "credit"/"debit"` convention | L134 | **MUST FOLLOW**: `Number(amount) >= 0 ? "credit" : "debit"` |
| `marketValue: 0` on getBalances | L108 | **MUST FOLLOW** — always `0` |
| `asOf: Date.now()` fallback | L113 | **MUST FOLLOW** |
| Graceful cache-miss fallback | L106-107 | **MUST FOLLOW** for getBalances |
| Filter pending transactions | L133 | **MUST FOLLOW** — filter by `status !== "COMPLETED"` |
| `fees: 0` default | L136 | **MUST FOLLOW** — use API value if available |

### B. Coinbase-Specific Patterns (different from SimpleFIN)

| Aspect | SimpleFIN | Coinbase |
|--------|-----------|----------|
| Auth | Basic over HTTPS | ES256 JWT Bearer |
| listAccounts endpoint | `/accounts?balances-only=1` | `/accounts` (cursor paginated) |
| getHoldings | Returns `[]` (banking) | Returns real crypto holdings per UUID |
| getHoldings endpoint | N/A | `/accounts/{uuid}` |
| getTransactions endpoint | `/accounts` (bulk, all accts) | `/accounts/{uuid}/transactions` (per-uuid, cursor paginated) |
| Date conversion | `posted * 1000` (epoch-s→ms) | `Date.parse(created_at)` (ISO-8601→ms) |
| Cache strategy | One fetch caches all accounts | Per-uuid; cache listAccounts response; fetch individually for getHoldings/getTransactions |

### C. Gotchas Checklist

1. **🔴 G1: `getHoldings` ignores accountId** — `coinbase.ts:27` has `(s: Session)` but contract requires `(s: Session, accountId: string)`. Fix signature AND behavior.
2. **🔴 G2: prices.ts 404** — `prices.ts:8-10` has `/spot` suffix. Fix URL to drop `/spot`.
3. **🟠 G3: Timestamp units** — Coinbase returns ISO-8601 (`Date.parse()` → ms). Do NOT use SimpleFIN's `*1000` pattern.
4. **🟠 G4: Watermark advances on failure** — `registry.ts:100` sets watermark after getTransactions regardless of pagination completion.
5. **🟡 G5: Cursor pagination** — Must loop `has_next` inside `getTransactions`. The watermark only seeds `start_date`.
6. **🟡 G6: Stablecoin price lookup** — Set `cashEquivalent: true` for USDC/USDT/DAI so normalizer overrides to `"cash"`.
7. **🟡 G7: Fresh JWT per request** — Each CDP API call needs a new JWT (the `uri` is request-specific).
8. **🟢 G8: `since` is `undefined` on first sync** — Don't add `start_date` when `since` is `undefined`.
9. **🟢 G9: `amount.value` signed** — `abs()` for qty; sign determines credit/debit type.
10. **🟢 G10: Ed25519 not supported** — CDP Brokerage API requires ECDSA P-256 keys.

### D. What NOT to change

- `src/ingest/contract.ts` — types are correct
- `src/ingest/matrix.ts` — coinbase already registered at L7
- `src/ingest/normalizer.ts` — already handles cashEquivalent, negative qty
- `src/store/symbols.ts` — already prefixes crypto with `CRYPTO:`
- `src/valuation/value.ts` — already has correct price cascade, ignores market_value
- `src/ingest/secrets.ts` — already supports `{ coinbase: { keyName, privateKey } }` shape
