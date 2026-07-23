# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-07-23
### Changed
- feat(cursor): replace child-process HTTP/2 bridge with an in-process Connect transport (HTTP/2 default, HTTP/1.1+SSE fallback) — fixes intermittent "lost connection to the upstream provider" failures
- feat(cursor): add `PI_CURSOR_HTTP_1_1` and `PI_CURSOR_TRANSPORT` env vars; classify and retry transient stream errors; H2 PING keepalive every 30s; `AbortSignal` propagation; single auth-refresh retry
- deprecate(cursor): `h2-bridge.mjs` / `spawnBridge` retained behind `PI_CURSOR_TRANSPORT=child`

## [0.1.3] - 2026-06-20
### Changed
- chore: remove @pi-stef/superpowers-adapter and all references (M5)


## [0.1.2] - 2026-06-17
### Changed
- feat(all): add repository and homepage fields to all package.json files


## [0.1.1] - 2026-06-15
### Changed
- feat(cursor): implement milestone M1 - create @pi-stef/cursor package
