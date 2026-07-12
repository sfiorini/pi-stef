# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-07-12
### Changed
- fix(finance): CSV crypto import + tool wiring arg-position bug


## [0.2.2] - 2026-07-11
### Changed
- feat(finance): add gain/loss to holdings output


## [0.2.1] - 2026-07-11
### Changed
- fix(finance-api): correct net worth, asset classification, add per-account valuations


## [0.2.0] - 2026-06-30
### Changed
- docs: exhaustive finance/finance-api overhaul — co-equal providers, genericized File Import, SnapTrade client config
- feat(finance): SnapTrade Personal-only auth + provider-scoped sync


## [0.1.2] - 2026-06-29
### Changed
- feat(finance-api): GHCR Docker publish workflow + comprehensive docs


## [0.1.1] - 2026-06-29
### Changed
- fix(finance): read auto-generated token + allow absolute paths in import
- docs(finance): add package READMEs
- fix(finance): fix client↔server route contract mismatch (explicit path table)
- fix(finance): fix typecheck errors in tools and client
- test(finance): add client↔server integration test
- feat(finance): add sf_fin_* tool registry + output formatting
- feat(finance): add service HTTP client (GET/POST contract)
- chore(finance): wire finance + finance-api into workspace and tsconfig
- feat(finance): add config loader with defaults/file/env merge
- feat(finance): scaffold extension package skeleton
