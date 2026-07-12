# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.5] - 2026-07-12
### Changed
- docs: content-based import + Postman + Swagger update
- fix(finance): client reads file locally and sends content to server
- docs: update CSV import + holdings docs for crypto, quoted fields, gain/loss


## [0.3.4] - 2026-07-12
### Changed
- fix(finance): CSV crypto import + tool wiring arg-position bug


## [0.3.3] - 2026-07-11
### Changed
- feat(finance): add gain/loss to holdings output


## [0.3.2] - 2026-07-11
### Changed
- chore(finance-api): regenerate Postman collection with holdings query params
- fix(finance-api): correct net worth, asset classification, add per-account valuations
- docs(finance-api): clarify server vs client paths and SnapTrade credential location


## [0.2.2] - 2026-07-11
### Changed
- fix(finance-api): Docker tsx binary not found in pnpm workspace layout


## [0.2.1] - 2026-07-10
### Fixed
- fix(finance-api): Docker image could not start — `npx tsx` failed in pnpm workspace layout (tsx binary lives in `packages/finance-api/node_modules/.bin/`, not the workspace root). Switched CMD to use explicit `./node_modules/.bin/tsx` with WORKDIR set to the package directory.

## [0.2.0] - 2026-06-30
### Changed
- docs: exhaustive finance/finance-api overhaul — co-equal providers, genericized File Import, SnapTrade client config
- feat(finance): SnapTrade Personal-only auth + provider-scoped sync
- docs: milestone 4 — SnapTrade provider documentation (README + docs-site page + sidebar)
- feat(finance-api): milestone 3 — registry wiring (snaptrade key) + end-to-end ingest integration
- feat(finance-api): milestone 2 — SnapTrade adapter over official SDK with injectable client seam
- feat(finance-api): add snaptrade-typescript-sdk dependency
- feat(finance-api): milestone 1 — persistence framework (balances table, txn/balance/watermark repo, runIngest persistence)
- docs(finance-api): exhaustive data import guide with CSV/OFX specs and per-service export instructions


## [0.1.2] - 2026-06-29
### Changed
- feat(finance-api): GHCR Docker publish workflow + comprehensive docs


## [0.1.1] - 2026-06-29
### Changed
- fix(finance-api): bind Docker to localhost only
- fix(finance): read auto-generated token + allow absolute paths in import
- fix(finance-api): persist token/config in Docker volume
- docs(finance): add package READMEs
- fix(finance-api): add pnpm-workspace.yaml to Dockerfile
- fix(finance-api): delete orphaned lots when replacing holdings
- fix(finance-api): add tsx as dependency for Docker/native execution
- fix(finance-api): read SF_FINANCE_HOST from env for Docker deployment
- docs(finance-api): add native run + launchd/systemd docs
- feat(finance-api): add Dockerfile + docker-compose
- test(finance-api): add daemon test + improve tick test assertions
- fix(finance-api): wrap holdings replacement in transaction
- fix(finance-api): clear stale holdings, thread dataFeed, per-holding error handling
- fix(finance-api): thread dataFeed through sync + validate goal required fields
- fix(finance-api): catch classifySession in runTick, fall back to closed
- fix(finance-api): wrap daemon scheduling in try/catch to prevent crash on year-guard
- fix(finance-api): restore year-guard throw as plan specifies
- fix(finance-api): fix saveSecrets to chmod existing files to 0600
- fix(finance-api): skip DCA spam, thread dataFeed through daemon
- fix(finance-api): validate import path, thread dataFeed, fix ET year guard
- fix(finance-api): fix rebalance zero-holdings + Stooq .us suffix
- fix(finance-api): persist market_sessions + thread registry/creds through server
- fix(finance-api): wire daemon in bin, fix import/sync routes to actually run
- feat(finance-api): add scheduler daemon loop
- feat(finance-api): add session-aware tick runner
- fix(finance-api): remove classifySession year-guard throw (fallback to weekday-only)
- fix(finance-api): fix history accountId filter + wrap classifySession try/catch
- fix(finance-api): add drift route, fix secrets perms, include bin in typecheck
- fix(finance-api): fix bin entry (use tsx), OFX dates, goal validation
- fix(finance-api): restrict export path + wire bin entry + add route tests
- fix(finance-api): secure token file (0600) + use market value for net worth/allocation
- fix(finance-api): fix typecheck errors in server code
- feat(finance-api): add startServer + secrets loader
- feat(finance-api): add structured logger + 0600 secrets hardening
- feat(finance-api): add Hono /v1 routes (GET reads / POST writes) + auth + staleness
- feat(finance-api): add bearer-token bootstrap (race-safe) + auth middleware
- feat(finance-api): add suggestion + goal repo helpers
- feat(finance-api): add suggestion-record assembler
- feat(finance-api): add risk checks + acceptance-band (limit) prices
- feat(finance-api): add DCA schedule computation
- feat(finance-api): add rebalance plan computation
- feat(finance-api): add allocation drift computation
- feat(finance-api): add goal-config validation
- fix(finance-api): fix stooq Close column (row[6]) + add Juneteenth holiday
- fix(finance-api): fix typecheck error in prices test
- feat(finance-api): add price feed (stooq default, coinbase ticker for crypto)
- feat(finance-api): add market session classifier (US, holidays)
- fix(finance-api): remove unused parameter in coinbase adapter
- feat(finance-api): add default provider registry (matrix)
- feat(finance-api): add Teller aggregator adapter stub (BoA)
- feat(finance-api): add SimpleFIN aggregator adapter stub (BoA)
- feat(finance-api): add SnapTrade aggregator adapter stub (Fidelity)
- feat(finance-api): add Coinbase Advanced Trade adapter (fetcher-injected)
- feat(finance-api): add file-import provider adapter (CSV+OFX)
- feat(finance-api): add BoA OFX/Quicken parser
- feat(finance-api): add Fidelity/BoA positions CSV parser
- fix(finance-api): validate port, thread asOf, exercise getTransactions/getBalances
- fix(finance-api): persist tax lots + add stub bin/docker directories
- fix(finance-api): clear stale flags on successful re-ingest
- feat(finance-api): add ingest registry + runIngest (staleness on error)
- feat(finance-api): add raw→canonical normalizer
- feat(finance-api): define ProviderAdapter contract
- fix(finance-api): remove unused import in backup test
- feat(finance-api): add SQLite backup + JSON export
- feat(finance-api): add canonical symbol mapping (CRYPTO: namespace)
- feat(finance-api): add db open + repo UPSERT/query helpers
- feat(finance-api): add versioned, incremental migration runner
- feat(finance-api): add SQLite schema DDL as numbered migrations
- feat(finance-api): add config loader (defaults/file/env)
- feat(finance-api): scaffold package skeleton
