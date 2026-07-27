# Documentation Mapping: Coinbase Provider

**Date:** 2026-07-27
**Scope:** Where and how to write ultra-detailed Coinbase provider docs

---

## 1. Docs Site Architecture

### Framework & Location

- **Framework:** VitePress 1.x (inferred from `vitepress` CLI in build scripts)
- **Source directory:** `docs-site/`
- **Config:** `docs-site/.vitepress/config.ts`
- **Build output:** `docs-site/.vitepress/dist/` (gitignored per `.gitignore:10`)
- **Base path:** `/pi-stef/` — deployed to `https://sfiorini.github.io/pi-stef/`

### Build/Dev Commands (root `package.json`)

```
"docs:dev":     "vitepress dev docs-site"        # local dev server
"docs:build":   "vitepress build docs-site"       # production build
"docs:preview": "vitepress preview docs-site"     # preview built output
```

No other docs-related scripts exist (no lint, no link-check, no markdownlint).

### VitePress Config — Navigation & Sidebar

File: `docs-site/.vitepress/config.ts`

**Nav bar** (lines 7-12):
```
Home | Getting Started | Packages | Catalog Guide | Development
```

**Sidebar** has three sections:
1. **"Guide"** (lines 20-27) — getting-started, catalog-guide, profiles, migration pages
2. **"Packages"** (lines 29-56) — ALL packages, including finance-api sub-pages
3. **"Development"** (lines 58-62) — contributing page

Key excerpt from the Packages sidebar (lines 44-52):
```ts
{ text: "finance-api", link: "/packages/finance-api" },
{ text: "finance-api Docker", link: "/packages/finance-api-docker" },
{ text: "finance-api File Import", link: "/packages/finance-api-file-import" },
{ text: "finance-api SnapTrade", link: "/packages/finance-api-snaptrade" },
{ text: "finance-api SimpleFIN", link: "/packages/finance-api-simplefin" },
```

**Coinbase is NOT listed in the sidebar.** It must be added here as a new entry:
```ts
{ text: "finance-api Coinbase", link: "/packages/finance-api-coinbase" },
```

**Edit location:** `docs-site/.vitepress/config.ts:52` — add after the SimpleFIN line (line 52) but before `paths` (line 53).

**Features:** local search (`search: { provider: "local" }`), edit links to GitHub, no `ignoreDeadLinks` config found.

### No separate `docs-site/package.json`

VitePress is a root-level dependency. All `docs:*` scripts are in the root `package.json`.

---

## 2. Existing Provider Documentation — Patterns & Conventions

### Three existing provider pages (each ~70-250 lines)

| Page | File | Length | Structure |
|------|------|--------|-----------|
| SimpleFIN | `docs-site/packages/finance-api-simplefin.md` | ~160 lines | Title → intro → Credentials → Auth flow → Self-provision → What is synced → Rate limits → Sync examples → Data mapping → Troubleshooting |
| SnapTrade | `docs-site/packages/finance-api-snaptrade.md` | ~140 lines | Title → intro → Credentials → Connect brokerages → Triggering sync → What gets synced → Limitations → Troubleshooting |
| File Import | `docs-site/packages/finance-api-file-import.md` | ~250 lines | Title → intro → Supported formats → CSV spec (required/optional cols, parsing behavior, crypto) → OFX spec → Export guide → curl examples → Troubleshooting |

### Common Conventions

1. **Title:** `# ProviderName provider` (e.g., `# SimpleFIN provider`, `# SnapTrade provider`, `# File Import provider`)
2. **Opening paragraph:** 1-2 sentences explaining what the provider does. Uses bold for key differentiators.
3. **Block quote callout:** `> **Key differentiator.**` callout early (SimpleFIN has one, File Import has one)
4. **Code blocks:** `bash` for curl examples, `json` for config, `csv` for CSV examples
5. **Cross-links:** `[finance-api page](./finance-api)` and `[other provider](./finance-api-snaptrade)` — relative links within docs-site
6. **Tables:** Used for credentials, data mapping, supported formats, limitations
7. **Troubleshooting section:** Always at the end, table format: Symptom | Likely cause | Fix
8. **No frontmatter** — just a `#` title, no YAML `---` block (unlike `index.md` which has `layout: home`)
9. **Credential guidance:** Explicit about whether credentials live in client `config.json` or server `secrets.json`

### Existing Provider Table on finance-api.md

File: `docs-site/packages/finance-api.md`

The "Providers" section (currently around line 71-79) has this table:
```markdown
| Provider | Kind | Status |
|----------|------|--------|
| [File Import](./finance-api-file-import) | brokerage/banking | ✅ Working |
| Coinbase | crypto | ⚠️ Stub |
| [SnapTrade](./finance-api-snaptrade) | brokerage | ✅ Working |
| [SimpleFIN](./finance-api-simplefin) | banking | ✅ Working |
| Teller | banking | ⚠️ Stub |
```

**Coinbase is listed WITHOUT a link.** When the doc page is created, `Coinbase` must become `[Coinbase](./finance-api-coinbase)`.

### secrets.json Format — Where Documented

In `packages/finance-api/README.md` (the canonical README, mirrored on docs-site):

```json
{
  "coinbase": {
    "keyName": "your-api-key",
    "privateKey": "your-private-key"
  }
}
```

Location in README: Lines around 98-107 (Provider credentials section). The README states this is for "future server-side providers (Coinbase, Teller) that are currently stubs."

Type in code: `packages/finance-api/src/ingest/contract.ts:3` — `Credentials { [key: string]: string }` — keyName and privateKey are arbitrary key-value strings.

---

## 3. Coinbase-Specific Documentation Content (from Implementation Report)

The implementation report (`ai_plan/2026-07-27-coinbase-provider-research/coinbase-provider-implementation-report.md`) contains ultra-detailed technical specs. Key sections to adapt for docs:

### Auth Mechanism (report §2)
- CDP ES256-JWT Bearer tokens (NOT HMAC)
- Key format: `organizations/{org_id}/apiKeys/{key_id}`
- Private key: PEM EC P-256 (`-----BEGIN EC PRIVATE KEY-----`)
- Ed25519 NOT supported
- JWT per-request, 120s lifetime
- URI field: `"<METHOD> api.coinbase.com<path>"`

### Endpoint Map (report §3)
- `listAccounts`: `GET /api/v3/brokerage/accounts` (cursor-paginated, limit default 49 / max 250)
- `getHoldings`: `GET /api/v3/brokerage/accounts/{uuid}` (per-UUID)
- `getTransactions`: `GET /api/v3/brokerage/accounts/{uuid}/transactions` (cursor-paginated, date-filtered via `start_date` ISO-8601)
- `getBalances`: `GET /api/v3/brokerage/accounts/{uuid}` (for USD/fiat account)
- Prices: Public `GET /api/v3/brokerage/market/products/{product_id}` or fallback `/v2/prices/{pair}/spot`

### Data Mapping (report §4)
- **§4.1 RawAccount:** `uuid` → `providerAccountId`, kind=`"crypto"`, name/currency direct, no `maskLast4`
- **§4.2 RawHolding:** `currency` → symbol, `available_balance.value` → quantity (abs), stablecoins → `cashEquivalent: true`
- **§4.3 RawTxn:** `created_at` → ms-epoch via `Date.parse()` (NOT `*1000`), type=credit/debit based on sign
- **§4.4 RawBalances:** cash from fiat account, marketValue=0
- **§4.5 Symbol normalization:** `CRYPTO:` prefix via `src/store/symbols.ts`, stablecoins → `assetClass: "cash"` via normalizer

### Critical Gotchas (report §6)
- **G1:** Stub keys on currency, not UUID — fixed in implementation
- **G2:** `prices.ts` 404 bug — pre-existing, separate fix (market/products/:id/spot → market/products/:id)
- **G3:** Timestamp units mismatch — ISO-8601 (Coinbase) vs ms-epoch (internal)
- **G4:** Watermark advances on failure — silent transaction gaps possible
- **G5:** Pagination ≠ watermark — cursor loop must complete inside single `getTransactions` call
- **G6:** Stablecoin price lookup — `USDC-USD` product doesn't exist; use `cashEquivalent: true`
- **G7:** JWT per-request — fresh JWT every API call (URI is request-specific)
- **G8:** `since` is `undefined` on first sync — only add `start_date` when `since` is a number
- **G9:** `amount.value` is signed — use `Number()` then `abs()` for qty; sign determines type
- **G10:** Ed25519 keys not supported — must be ECDSA/P-256

### Rate Limits (report §3)
- 10,000 requests/hour per API key
- 429 response: `{"errors":[{"id":"rate_limit_exceeded"}]}`
- Public market endpoints: ~1s cache

---

## 4. Precise List of Files to CREATE or EDIT

### CREATE: `docs-site/packages/finance-api-coinbase.md`

This is the main new doc page. It must follow the exact convention of existing provider pages.

**Required sections (in order):**

| # | Section | Content Source | Detail Level |
|---|---------|---------------|-------------|
| 1 | `# Coinbase provider` | Follow title convention | H1 title |
| 2 | Intro paragraph | New | Explain: Coinbase is a crypto-only provider using CDP API keys. Server-side credentials in `secrets.json`. Syncs account balances, holdings, and transactions for all Coinbase crypto wallets. |
| 3 | `> **Server-side provider.**` callout | New | Contrast with client-side providers (SnapTrade/SimpleFIN): credentials live in `secrets.json` on the server, NOT in client `config.json`. |
| 4 | `## Prerequisites` | Report §2 | Creating a CDP API key: organization, key name, EC P-256 private key. Link to Coinbase CDP docs. Warning about Ed25519. |
| 5 | `## Credentials` | Report §2 | `secrets.json` format exactly: `{ "coinbase": { "keyName": "...", "privateKey": "..." } }`. Key format: `organizations/{org_id}/apiKeys/{key_id}`. Private key format: PEM `-----BEGIN EC PRIVATE KEY-----`. Where `secrets.json` lives: `~/.pi/sf/finance/secrets.json` on the server. |
| 6 | `## Authentication` | Report §2 | ES256-JWT Bearer auth. JWT per request with 120s lifetime. `uri` field format. NOT HMAC / `CB-ACCESS-*` headers. SDK option: `@coinbase/cdp-sdk` `generateJwt`. |
| 7 | `## What is synced` | Report §3-4 | Accounts (all crypto wallets), holdings (per-currency balance), transactions (buys/sells/transfers), balances (USD/fiat cash). Note: no `avgCost` available from Coinbase API. |
| 8 | `## Data mapping` | Report §4 | Tables for: Accounts, Holdings, Transactions, Balances. Exact field-by-field mapping with transform notes. |
| 9 | `## Rate limits` | Report §3 | 10,000 req/hr. 429 handling. Public endpoints available. |
| 10 | `## Sync examples` | New | curl examples for `POST /v1/sync` with Coinbase provider. What the response looks like. How to verify: `GET /v1/holdings`. |
| 11 | `## Limitations` | Report §6 | No `avgCost` (Coinbase API doesn't provide it), no `maskLast4`, no `securityType`, fees field TBD, Ed25519 key unsupported, must use EC P-256 key. |
| 12 | `## Troubleshooting` | Report §6 | Table: auth failures (wrong key type, Ed25519), 401 (JWT expired/invalid), rate limits (429), empty accounts (no crypto wallets), watermark issues. |

### EDIT: `docs-site/.vitepress/config.ts`

Exact change needed at line 52:

```diff
          { text: "finance-api SimpleFIN", link: "/packages/finance-api-simplefin" },
+         { text: "finance-api Coinbase", link: "/packages/finance-api-coinbase" },
          { text: "paths", link: "/packages/paths" },
```

The entry goes in the "Packages" sidebar group, alphabetically between SimpleFIN and paths (following the convention that finance-api sub-pages are grouped together after finance-api but sub-sorted alphabetically).

### EDIT: `docs-site/packages/finance-api.md`

Two changes needed:

1. **Provider table** (around line 71-79): Make "Coinbase" a link:
```diff
-| Coinbase | crypto | ⚠️ Stub |
+| [Coinbase](./finance-api-coinbase) | crypto | ✅ Working |
```

2. **Provider credentials note** (around lines 60-68): Update the sentence about `secrets.json` being "reserved for future server-side providers":
```diff
-The `secrets.json` file (at `~/.pi/sf/finance/secrets.json` on the server) is reserved for future server-side providers (Coinbase, Teller) that are currently stubs.
+The `secrets.json` file (at `~/.pi/sf/finance/secrets.json` on the server) is for server-side providers. [Coinbase](./finance-api-coinbase) uses server-side CDP API keys.
```

### EDIT: `packages/finance-api/README.md` (canonical README)

Same two changes as `docs-site/packages/finance-api.md` — keep them in sync:

1. Provider table: Link Coinbase, update status
2. Provider credentials section: Update `secrets.json` description

### EDIT: Root `README.md` (optional)

The root README has a packages table. The finance-api entry (around line 19) says "Always-on local service for financial data ingestion and quant engine". No provider-specific info there — no change strictly needed, but could add a note about providers.

---

## 5. Sidebar Config Edit — Exact Details

**File:** `docs-site/.vitepress/config.ts`
**Insert at:** Line 52 (after `finance-api SimpleFIN` entry, before `paths` entry)
**New entry:**
```ts
{ text: "finance-api Coinbase", link: "/packages/finance-api-coinbase" },
```

**Context (lines 47-54):**
```ts
{ text: "finance-api", link: "/packages/finance-api" },
{ text: "finance-api Docker", link: "/packages/finance-api-docker" },
{ text: "finance-api File Import", link: "/packages/finance-api-file-import" },
{ text: "finance-api SnapTrade", link: "/packages/finance-api-snaptrade" },
{ text: "finance-api SimpleFIN", link: "/packages/finance-api-simplefin" },
// INSERT HERE
{ text: "paths", link: "/packages/paths" },
```

The naming convention for finance-api sub-pages is `finance-api <ProviderName>` (camelCase for Docker/FileImport etc., ProperCase for SnapTrade/SimpleFIN/Coinbase).

---

## 6. Docs Linting, Link-Checking, Build Requirements

### What exists

| Check | Status |
|-------|--------|
| VitePress build | ✅ `pnpm docs:build` — runs `vitepress build docs-site`. Dead internal links will cause build failure (VitePress default behavior). |
| Markdown lint | ❌ No `markdownlint`, `remark`, or `eslint` for `.md` files found anywhere in repo. |
| Link checker | ❌ No `linkcheck`, `deadlink`, or `check-links` scripts found. |
| TypeScript | ✅ `pnpm typecheck` (`tsc -b`) — covers `.ts` files only, not docs. |
| Tests | ✅ `pnpm test` — covers code, not docs. |

### Pre-merge checklist

1. **`pnpm docs:build` must pass** — this is the sole docs gate. VitePress will fail on:
   - Dead internal links (e.g., `[broken](./nonexistent)`)
   - Missing referenced pages
   - Invalid sidebar/nav config
2. **Verify all cross-links** in `finance-api-coinbase.md` resolve correctly:
   - `./finance-api` → `docs-site/packages/finance-api.md` ✅ exists
   - `./finance-api-snaptrade` → `docs-site/packages/finance-api-snaptrade.md` ✅ exists
   - `./finance-api-simplefin` → `docs-site/packages/finance-api-simplefin.md` ✅ exists
   - `./finance-api-file-import` → `docs-site/packages/finance-api-file-import.md` ✅ exists
3. **No external links** need verification beyond what VitePress does (VitePress doesn't check external links by default)

---

## Summary: Files to Create/Edit

| Action | File | Section Required |
|--------|------|-----------------|
| **CREATE** | `docs-site/packages/finance-api-coinbase.md` | Full ultra-detailed provider guide (12 sections per §4 above) |
| **EDIT** | `docs-site/.vitepress/config.ts:52` | Add `{ text: "finance-api Coinbase", link: "/packages/finance-api-coinbase" }` |
| **EDIT** | `docs-site/packages/finance-api.md` | Link Coinbase in provider table; update `secrets.json` description |
| **EDIT** | `packages/finance-api/README.md` | Same edits as `finance-api.md` for sync |
