# File Import provider

File Import is a co-equal provider that ingests holdings and transactions from manual file uploads via `POST /v1/import`. It covers two formats: CSV (for holdings/positions from any brokerage export) and OFX (for transactions + cash balance from bank exports). This is a good fit for institutions not covered by SnapTrade, or when you prefer not to grant API access.

Providers can be combined — e.g. SnapTrade for live brokerage sync *and* File Import for a bank OFX export. (Cross-provider account deduplication is not supported yet; see the [finance-api page](./finance-api) for the limitation.)

## Supported formats

| Format | Extension | Data imported | Use case |
|--------|-----------|---------------|----------|
| CSV | `.csv` | Holdings (positions) | Brokerage exports (any broker that exports a positions CSV) |
| OFX | `.ofx`, `.qfx` | Transactions + balances | Bank exports (checking, savings) |

The service detects the format automatically: `.csv` → positions, OFX → transactions + cash balance.

---

## CSV format specification

The CSV parser expects a **positions-style CSV** — one row per holding, with a header row. It is flexible on column names but strict about what data it extracts.

### Required columns

| Column | Accepted header names (case-insensitive, trimmed) | Example value | Notes |
|--------|---------------------------------------------------|---------------|-------|
| **Symbol** | `symbol` | `AAPL`, `VTI`, `FXAIX` | Must be non-empty. Any string works — no ticker validation. |
| **Quantity** | `quantity`, `shares`, `qty` | `10`, `5.123`, `100` | Must be a non-zero number. Whitespace/symbols stripped (see below). |

### Optional column

| Column | Accepted header names | Example value | Notes |
|--------|----------------------|---------------|-------|
| **Price** | `last price`, `price` | `190.50`, `$3,450.00` | If absent, holdings import with no average cost. Stored as `avgCost`, not "last price." The net-worth endpoint uses the latest price from the price feed. |

### How numeric values are parsed

Every numeric field (quantity, price) goes through this transformation:

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
>
> ⚠️ **Negative quantities become positive.** If your export uses `-10` for short positions, the parser forces it to `10`. Short positions are not currently supported.

### Known parser limitations

1. **No quoted-field support.** The parser uses `split(",")` — any comma inside a value (e.g. `"Apple, Inc."` as a description column) breaks column alignment. Remove commas from text fields before importing.

2. **`assetClass` is always `"equity"`.** All CSV-imported holdings are tagged as equity. There is no way to import bonds, cash, or crypto via CSV. The `subclass` is always `"us"`.

3. **Any column beyond the 3 recognized ones is ignored.** Extra columns like `Description`, `Account`, `Last Price Change`, `Cost Basis` are silently discarded.

4. **Empty/zero-quantity rows are silently skipped.** A CSV with only a header and no data rows returns `[]`.

### Minimum valid CSV

```csv
Symbol,Quantity
AAPL,10
VTI,5.123
```

### Fully specified CSV (typical brokerage export)

```csv
Account,Symbol,Description,Quantity,Last Price
Brokerage,AAPL,Apple Inc.,10,190.50
Brokerage,VTI,Total Stock Market,5.123,180.00
```

Most brokerages export positions with a header row like `Account,Symbol,Description,Quantity,Last Price` (sometimes `Shares` instead of `Quantity`, or `Price` instead of `Last Price`). The parser accepts all of these.

---

## OFX format specification

The OFX parser supports standard OFX 1.x / QFX files (the format used by most banks for transaction downloads).

### What the parser extracts

| XML element | Mapped to | Default if absent |
|-------------|-----------|-------------------|
| `<ACCTID>` | Account ID | `"unknown"` |
| `<BALAMT>` | Cash balance | `0` |
| `<STMTTRN>` → `<TRNAMT>` | Transaction amount | `0` |
| `<STMTTRN>` → `<DTPOSTED>` | Transaction date (YYYYMMDD or YYYYMMDDHHMMSS) | unix epoch `0` (1970-01-01) |
| `<STMTTRN>` → `<NAME>` | Payee name (parsed, then discarded — see below) | `""` (empty) |

### What reaches the API response

The file adapter transforms parsed OFX data before it reaches the API:

| Field | Parser layer | Adapter layer (API response) |
|-------|-------------|------------------------------|
| Balance | `parseOfx().balance` | `{ cash: balance, marketValue: 0, asOf: Date.now() }` — treated as cash |
| Transactions | `parseOfx().transactions` | `{ id: "${arrayIndex}", date: unixMs, type: "credit"\|"debit", fees: 0 }` |
| Payee (`<NAME>`) | ✅ Parsed by `parseOfx` | ❌ **Discarded** — not present in API response |
| Fees | Not parsed | Hardcoded to `0` |
| Symbol/quantity | N/A | N/A — OFX imports transactions, not holdings |

> ⚠️ **The payee name (`<NAME>`) is parsed from the OFX file but discarded by the adapter.** Imported transactions have no payee/description field. This is a known gap.
>
> ⚠️ **OFX holdings are always empty.** OFX is for banking transactions. To import positions (stocks/ETFs), use CSV.

### Date parsing

OFX dates are parsed as `YYYYMMDD` or `YYYYMMDDHHMMSS`. If the date string is empty or shorter than 8 characters, the date defaults to unix epoch `0` (1970-01-01). In practice this never happens with real OFX exports.

### Detection

- The file adapter checks for `.ofx` extension (in `getHoldings`).
- Files containing the literal `OFXHEADER` are treated as OFX (in `getTransactions`/`getBalances`). This is how `.qfx` files work — they always contain `OFXHEADER`.
- A file without `.ofx` extension AND without `OFXHEADER` content will not be parsed as OFX.

---

## How to export from your brokerage

The CSV parser accepts any positions export with a `Symbol` column and a `Quantity`/`Shares`/`Qty` column (an optional `Last Price`/`Price` column is read as average cost). The exact menu path varies by brokerage, but the steps are the same everywhere:

1. **Log into your brokerage's website** and navigate to your Portfolio / Positions / Holdings page.
2. **Select the account** you want to export.
3. **Look for Download / Export** — typically a down-arrow icon or a link near the positions table header.
4. **Choose CSV format** (not PDF, not Excel).
5. **Save the file** — it typically downloads as `Positions_<date>.csv` or similar.
6. **Check the headers** — you need `Symbol` and one of `Quantity`/`Shares`/`Qty`. A `Last Price`/`Price` column is optional. Extra columns (Description, Account, Cost Basis, …) are ignored.

### Import the file

```bash
TOKEN=$(docker compose -f packages/finance-api/docker/docker-compose.yml exec -T finance-api cat /root/.pi/sf/finance/token 2>/dev/null || cat ~/.pi/sf/finance/token)

curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/Users/me/Downloads/positions.csv"}'
```

### Verify the import

```bash
curl -X GET http://127.0.0.1:7780/v1/holdings \
  -H "Authorization: Bearer $TOKEN"
```

> **Tip:** The price column (`Last Price` or `Price`) is stored as `avgCost` on the holding. The `/v1/net-worth` endpoint computes value using the latest price from the price feed, not this column — so a missing or stale price column is harmless.
>
> **Prefer live sync?** If your brokerage is one of the 30+ supported by [SnapTrade](./finance-api-snaptrade), that gives you automatic live sync with no manual exports.

---

## Exports that need adjustment

Some institutions export data in a shape the CSV parser can't read directly. This is not an exhaustive list — the same patterns apply to any similar export.

### Crypto exchanges (e.g. Coinbase)

**Reason:** Crypto exchanges export **transaction history**, not portfolio positions. A typical CSV has columns:

```
Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price,Subtotal,Total,Notes
```

No `Symbol` column — the data represents buys/sells/transfers, not current holdings.

**Manual workaround:**
1. Get current balances from the exchange UI (Dashboard → each asset → balance).
2. Create a CSV:
   ```csv
   Symbol,Quantity
   BTC,0.05
   ETH,2.0
   ```
3. Import with `POST /v1/import`.

**Alternative:** A direct Coinbase API aggregator is a stub in the current release.

### Banks (e.g. Bank of America)

**Reason:** Banks export **account activity** (transactions), not portfolio positions. A typical bank CSV has columns:

```
Date,Description,Amount,Running Bal.
```

No `Symbol`. No `Quantity`. This is a transaction ledger, not a position list.

**OFX is the recommended path:** Most banks support OFX/QFX download (via "Download Transactions" → choose "Microsoft Money" or "Quicken" format). Import the `.ofx` file:

```bash
curl -X POST http://127.0.0.1:7780/v1/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/Users/me/Downloads/bank-activity.ofx"}'
```

For brokerage positions held in a bank's investing arm (e.g. Merrill Edge for BoA), download a **positions export** from the investment section — these typically follow the `Symbol,Quantity,Last Price` format the parser accepts. Alternatively, use [SnapTrade](./finance-api-snaptrade) for live brokerage sync.

### If your CSV doesn't match

Most brokerages export positions with `Symbol`, `Quantity`/`Shares`, and optionally a `Last Price`/`Price` column. If your export has these columns under any accepted header name, it should import. Try it — if the import returns empty holdings, check that your CSV has `Symbol` and `Quantity`/`Shares`/`Qty` in the header row (`head -1 your-file.csv`).

---

## curl examples

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
curl -X GET http://127.0.0.1:7780/v1/holdings \
  -H "Authorization: Bearer YOUR_TOKEN"

curl -X GET http://127.0.0.1:7780/v1/net-worth \
  -H "Authorization: Bearer YOUR_TOKEN"

curl -X POST http://127.0.0.1:7780/v1/sync \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `"Missing filePath"` | No `filePath` in the JSON body | Add `"filePath": "/path/to/file.csv"` to your request body |
| `"Directory traversal is not allowed"` | Relative path contains `..` (e.g. `../../data.csv`) | Use an absolute path or a relative path without `..` — absolute paths are always allowed |
| Import succeeds but holdings are empty | CSV missing `Symbol` or `Quantity`/`Shares`/`Qty` header, or all rows have zero/empty quantities | Check your CSV header: `head -1 your-file.csv` |
| Imported quantities are wrong | CSV uses `(value)` for negatives (accounting convention) or `-value` for short positions | Short/negative quantities cannot be imported — `Math.abs()` forces all quantities positive. No workaround. Remove negative rows or accept them as positive. |
| Comma in description breaks the parse | `split(",")` splits on commas inside values (e.g. `"Apple, Inc."`) | Remove commas from all text fields before importing |
| Imported OFX transactions show `1970-01-01` | `<DTPOSTED>` is empty or malformed | Verify the file is valid — real bank exports always include dates |
| No merchant name on OFX transactions | Payee `<NAME>` is parsed but discarded by the adapter | Known limitation — transaction descriptions are not persisted |
| `401 Unauthorized` on import | Token missing or wrong | Retrieve it: `cat ~/.pi/sf/finance/token` (native) or `docker compose exec finance-api cat /root/.pi/sf/finance/token` (Docker) |

See the [finance-api page](./finance-api) for the HTTP API and [SnapTrade](./finance-api-snaptrade) for live brokerage aggregation.
