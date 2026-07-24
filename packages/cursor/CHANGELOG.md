# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.2] - 2026-07-24
### Changed
- fix(cursor): static AuthStorage import so /cursor-login + streaming read the stored key at runtime; migration page -> 1.0.0


## [1.0.1] - 2026-07-24
### Changed
- fix(cursor): add baseUrl to provider registration (pi requires it when defining custom models)


## [1.0.0] - 2026-07-24
### Changed
- cursor(audit): remove dead markToolStarted method (P3)
- cursor(audit): P2-c coordinator-owned toolcall dedup (bridgeToolStart) + already-aborted guard + pi__ strip
- cursor(audit): fix P0 stale-partial (2nd-turn empty), P1 lastSentMessageIndex + abort classification, P2 abort-flag/key-precedence/emitter-dedup, P3 close-catch/pi__-strip
- cursor(m8): S-87 release 0.3.0 (version bump + CHANGELOG)
- cursor(m8): S-84 delete bridge-recovery docs
- cursor(m8): S-83 rewrite protocol.md → SDK API reference
- cursor(m8): S-81 rewrite README — @cursor/sdk local-agent mode + API-key auth
- cursor(m7): S-73 delete bridge/proto/transport/wire + raw json + proto dep
- cursor(m7): S-72 delete proxy.ts + auth.ts
- cursor(m7): S-71 delete old bridge tests + fixtures
- cursor(m6): fix P0 stored-key resolution + P1 busy-pool guard
- cursor(m6): S-62 two-phase streamCursor (resume vs new-turn, cross-turn tool continuity)
- cursor(m6): S-61 create session-agent.ts (SessionAgent wrapper + 4-dim pool) + re-add session lifecycle cleanup
- cursor(m6): S-63 create http1-config.ts (PI_CURSOR_HTTP_1_1 -> SDK configure)
- cursor(m5): S-51 create tool-bridge.ts (pi tools -> SDKCustomTool via pending bridge)
- cursor(m5): S-52 create tool-result-bridge.ts (session pending registry + whenPending)
- cursor(m4): review fixes — rolePrefix default, text_end/thinking_end on block-switch, ConversationStep.name
- cursor(m4): S-42 create turn-coordinator.ts (deltas→events, exact SDK field accessors)
- cursor(m4): S-41 create context-builder.ts (full + incremental prompts)
- cursor(m3): fix P1 — use curated FALLBACK_MODELS on fallback source (don't round-trip through mapModelListItems)
- cursor(m3): S-34 create scripts/refresh-models.ts (manual CLI model regen)
- cursor(m3): S-33 wire model discovery into index.ts startup + /cursor-refresh-models
- cursor(m3): S-32 create model-discovery.ts (live→cache→fallback precedence)
- cursor(m3): S-31 rewrite model-cache.ts to SDK cache shape (fingerprint-keyed, TTL, 0600)
- cursor(m2): S-24 rewrite index.ts (cursor-sdk registration + /cursor-login + legacy warn)
- cursor(m2): S-23 create sdk-stream.ts stub (terminates with error) + test
- cursor(m2): S-22 create model-fallback.generated.ts + rewire model-config import
- cursor(m2): S-21 create api-key.ts (3-source resolve + legacy detect) + test
- cursor(m1): S-15 extract model logic into model-config.ts
- cursor(m1): S-14 create provider-errors.ts (classifyCursorError + isAbortError) + test
- cursor(m1): S-13 create sensitive-text.ts (redactCursorSecrets + fingerprintApiKey) + test
- cursor(m1): S-12 create sdk-runtime.ts (lazy loadCursorSdk seam) + test
- cursor(m1): S-11 update package.json deps (@bufbuild/protobuf kept for now), add @cursor/sdk, engines.node>=22.14


## [0.3.0] - 2026-07-23
### Breaking — Transport
- Replaced the reverse-engineered protobuf/HTTP2 bridge with the official `@cursor/sdk` local-agent mode. Resolves chronic mid-conversation disconnections.

### Breaking — Auth
- Replaced browser OAuth PKCE login with API-key auth. Run `/cursor-login <key>` (key from cursor.com/dashboard → API Keys) or set `CURSOR_API_KEY`. Old OAuth credentials are not migrated.

### Breaking — Removed env vars
- Removed `PI_CURSOR_TRANSPORT`, `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`, `PI_CURSOR_STREAM_IDLE_MAX_RETRIES`, `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS`, `CURSOR_ACCESS_TOKEN`, `PI_CURSOR_CLIENT_VERSION`, `PI_CURSOR_AGENT_URL`, `CURSOR_AGENT_URL`.

### Breaking — `api` field
- Changed `"cursor-native"` → `"cursor-sdk"`.

### Breaking — Node
- Requires Node ≥22.14.

### Added
- Model discovery via `Cursor.models.list` with a 24h disk cache (`~/.pi/agent/cursor-sdk-model-list.json`); agent pooling with SDK `enableAgentRetries`; cross-turn tool-call continuity via in-process `customTools`.

### Removed
- Deleted `auth.ts`, `bridge.ts`, `h2-bridge.mjs`, `connect-transport.ts`, `cursor-wire.ts`, `cursor-request-headers.ts`, `transport-errors.ts`, `proto/agent_pb.ts`, and the stream idle watchdog.

## [0.2.4] - 2026-07-23
### Changed
- chore(cursor): keep version at 0.2.3 (pnpm release will bump); move fix note under [Unreleased]
- fix(cursor): audit — register onResponseEnd in handleNonStreamingResponse (non-stream P1 hang)
- fix(cursor): audit — restore responseFinished gate in http1Adapter.isAlive (P2); close teardown-test loop (P3)
- release(cursor): v0.2.4 — fix continuation-bridge regression
- fix(cursor): S-22 writeSSEStream: identical onResponseEnd consumption (SSE cleanup primitives)
- fix(cursor): S-21 writeNativeStream: consume onResponseEnd + cleanCompletionHandled guard + completeCleanTurn; reproducing + clean-teardown tests
- fix(cursor): S-12 add onResponseEnd to BridgeHandle; wire buildBridgeHandle single-slot; spawnBridge no-op; +2 tests
- fix(cursor): S-11 add onResponseEnd to StreamAdapter; make http2Adapter + http1Adapter 'end' non-destructive
- test(cursor): reproducing test for continuation-bridge regression (RED on 0.2.3)

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
- docs(cursor): S-43 protocol.md for in-process transport
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
