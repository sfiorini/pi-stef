# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.4] - 2026-07-23
### Fixed
- fix(cursor): server half-close ('end') during a tool-call no longer destroys the live bridge — add non-destructive `onResponseEnd` transport/bridge signal; clean responses still complete + tear down (runaway-turn fix preserved), tool-call pauses keep the bridge alive + writable for the continuation

## [0.2.3] - 2026-07-23
### Changed
- chore(cursor): S-32 changelog 0.2.2 + version bump
- feat(cursor): S-23 wire cache-first model fallback + write-on-success
- feat(cursor): S-22 export tokenCacheHash + 15s model discovery timeout
- feat(cursor): S-21 model disk cache for restart-surviving model discovery
- fix(cursor): propagate server half-close ('end') to bridge onClose — M1


## [0.2.2] - 2026-07-23
### Changed
- fix(cursor): listen for HTTP/2 'end' / HTTP/1.1 res 'end' server half-close so turns complete instead of hanging until the idle watchdog
- feat(cursor): persist discovered models to ~/.pi/agent/cursor-models-cache.json and prefer the cache over stale bundled FALLBACK_MODELS on restart
- feat(cursor): raise model-discovery RPC timeout from 5s to 15s

## [0.2.1] - 2026-07-23
### Changed
- fix(cursor): clean up active bridge on transport-abort close path (round-2 P2)
- test(cursor): integration test closing the transport framing isolation gap
- fix(cursor): ferry raw Connect bytes on read path; abort/cancel + h1 fixes (audit P0-P3)
- fix(cursor): handle non-2xx HTTP statuses (audit P2, child-bridge parity)
- chore(cursor): S-44 changelog 0.2.0 + version bump
- docs(cursor): S-43 protocol.md + bridge-recovery.md for in-process transport
- docs(cursor): S-42 README transport model, env vars, OpenAI-compat rejection
- feat(cursor): S-41 deprecate child bridge behind PI_CURSOR_TRANSPORT=child
- feat(cursor): S-34 single auth-refresh retry on auth-classified close
- feat(cursor): S-33 propagate AbortSignal to the transport
- feat(cursor): S-32 H2 PING keepalive every 30s (reset-on-data-only)
- feat(cursor): S-31 classifyTransportError + route stream/end-stream errors through it
- test(cursor): S-23 HTTP/1.1 framing-parity fixture + cross-transport test
- feat(cursor): S-21 HTTP/1.1+SSE transport branch via node:https
- feat(cursor): S-22 resolveTransportMode env resolver (PI_CURSOR_HTTP_1_1)
- fix(cursor): guard write/end against destroyed h2 stream (M1 review P2)
- feat(cursor): S-14 default BridgeFactory to in-process transport (PI_CURSOR_TRANSPORT)
- feat(cursor): S-13 parse response Connect frames; surface end-stream errors via onClose
- feat(cursor): S-11 in-process Connect transport skeleton over node:http2
- feat(cursor): S-12 extract Cursor request headers into cursor-request-headers.ts


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
