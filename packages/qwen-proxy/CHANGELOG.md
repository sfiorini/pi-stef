# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.3] - 2026-08-14
### Changed
- fix(qwen-proxy): silence Chromium telemetry in bridge spawns (SOCKS auth throttle)


## [0.5.2] - 2026-08-14
### Changed
- fix(qwen-proxy): undici SOCKS dispatcher for proxied completions (rotation actually works)


## [0.5.1] - 2026-08-14
### Changed
- fix(qwen-proxy): lifetime error handlers on bridge sockets (ECONNRESET crash)


## [0.5.0] - 2026-08-14
### Changed
- fix(qwen-proxy): thread active proxy in refreshBaxiaToken (P2)
- fix(qwen-proxy): pipeBoth destroys peer on 'close' event (P3)
- fix(qwen-proxy): skip pre-warm in rotation mode (P2 #2) + stale docstring (P3 #3)
- fix(qwen-proxy): cold-failure cachedAt:null instead of epoch-0 (P3 #2)
- fix(qwen-proxy): replace require('socks') with static ESM import (P2 #1)
- fix(qwen-proxy): prevent double-encoding in normalizeSocksUrl (P3 #1)
- docs(qwen-proxy): resolve token/IP-mismatch limitation (proxy-affine tokens)
- feat(qwen-proxy): bin wiring for proxy-affine bridge (start/stop/setBridge)
- feat(qwen-proxy): thread {proxy} into both ensureToken call sites
- feat(qwen-proxy): bridge integration (setBridge + proxy-server args + lazy refresh)
- feat(qwen-proxy): global spawn mutex + stale fallback + status/proxyStatuses
- feat(qwen-proxy): baxia-token per-proxy cache (ensureToken({proxy}) + piggyback)
- feat(qwen-proxy): ProxyBridge forwarding (creds injection + pipe + upstream swap)
- feat(qwen-proxy): ProxyBridge SOCKS5 handshake (method-negotiation + CONNECT parse)
- feat(qwen-proxy): add ProxyBridge lifecycle (start/stop/setUpstream)
- feat(qwen-proxy): add socks dep + parseSocksUrl for SOCKS5 bridge


## [0.4.0] - 2026-08-14
### Changed
- fix(qwen-proxy): audit fixes (discovery timeout, dedup, isRotationTrigger, recreate doc)
- fix(qwen-proxy): proxy-rotation review fixes (bin fetcher, size-1 consistency, docs, creds)
- docs(qwen-proxy): document proxy rotation env knobs (NordVPN SOCKS5 pool) Add SF_QWEN_PROXY_COUNT/URLS/USER/PASS/COUNTRIES + SF_QWEN_TIMEOUT_MS to all 4 env tables; add a 'Proxy rotation (NordVPN SOCKS5 pool)' prose section to the README + docs-site qwen-proxy page (legacy vs rotation modes, token-gen-direct affinity, setup, graceful degrade, token/IP-mismatch empirical limitation).
- feat(qwen-proxy): bin wiring + app.ts proxyPool threading (e2e)
- feat(qwen-proxy): rotation branch in withPoolRetryStream (pre-first-content only)
- feat(qwen-proxy): rotation branch in withPoolRetry
- feat(qwen-proxy): add isRotationTrigger() error classifier
- feat(qwen-proxy): thread proxy? through retry op signature + adapters
- feat(qwen-proxy): TTFB timeout via AbortController (cleared on headers) doFetch wraps each chat.qwen.ai fetch in an AbortController that fires after SF_QWEN_TIMEOUT_MS (default 60s) if no response headers arrive; timer cleared on headers so long streams are never aborted mid-flight. AbortError (name-based check, handles DOMException + plain-Error aborts) surfaces as NetworkError (rotatable in proxy-rotation mode; mapped 503 legacy).
- feat(qwen-proxy): TTFB timeout via AbortController (cleared on headers) doFetch wraps each chat.qwen.ai fetch in an AbortController that fires after SF_QWEN_TIMEOUT_MS (default 60s) if no response headers arrive; the timer is cleared on headers so long streams are never aborted mid-flight. AbortError surfaces as NetworkError (rotatable in proxy-rotation mode, mapped 503 legacy).
- feat(qwen-proxy): thread proxy? through guest-client + typed non-OK errors
- feat(qwen-proxy): add NordVPN discovery + graceful degrade for createProxyPool
- feat(qwen-proxy): add normalizeSocksUrl, parseProxyUrls, createProxyPool
- feat(qwen-proxy): add socks-proxy-agent dep + ProxyPool + ProxyDispatcherCache + fetchWithProxy
- feat(qwen-proxy): add proxy rotation config knobs (types + load + tests)


## [0.3.2] - 2026-08-13
### Changed
- fix(qwen-proxy): parse /v1/models from upstream { data: [...] } shape


## [0.3.1] - 2026-08-13
### Changed
- fix(qwen-proxy): rotate Baxia token on empty-exhaustion to recover from sustained token-burn


## [0.3.0] - 2026-08-13
### Changed
- docs(qwen-proxy): fix stale rate-limit docstrings (models.ts + single.ts)
- docs(qwen-proxy): drop SF_QWEN_RATE_LIMIT_COOLDOWN_MS env row
- refactor(qwen-proxy): remove rateLimitCooldownMs config
- refactor(qwen-proxy): delete classifyResponse + parseRetryAfterMs + RATE_LIMIT_RE
- refactor(qwen-proxy): remove markRateLimitedAndSwitch from pool interface + adapter rewrites
- refactor(qwen-proxy): drop RateLimitError account-failover from retry.ts
- fix(qwen-proxy): purge SF_QWEN_USE_CHROME_BAXIA from Docker files + test non-OK moderation guard
- refactor(qwen-proxy): env-var cleanup + reclassify data_inspection moderation
- docs(qwen-proxy): document inline empty-retry env knobs
- feat(qwen-proxy): detect empty completions in non-stream path
- feat(qwen-proxy): inline retry-on-empty for non-stream path (429 on exhaustion)
- test(qwen-proxy): add finish_reason empty-retry regression guard
- feat(qwen-proxy): inline retry-on-empty for stream path (sentinel on exhaustion)
- refactor(qwen-proxy): flatten SingleAccountPool empty-cooldown (remove escalation state)
- feat(qwen-proxy): add EmptyCompletionError for semantic empty-completion detection
- feat(qwen-proxy): add inline retry config knobs (emptyRetryMax, emptyRetryGapMs) + lower emptyCooldownMs default to 10s


## [0.2.0] - 2026-08-12
### Changed
- docs(qwen-proxy): add landing-page tile + document SF_QWEN_MAX_CONCURRENCY
- feat(qwen-proxy): in-flight concurrency cap (SF_QWEN_MAX_CONCURRENCY, default 1)
- fix(qwen-proxy): default-alias common model names to current guest-mode ids (empty completions)
- test(qwen-proxy): assert Origin/Referer on createChatSession too (audit P3)
- fix(qwen-proxy): send Origin/Referer headers + full qwen body (empty completions)
- fix(qwen-proxy): match qwen2api's real baxia-token.js extraction (tokens never ready)
- fix(qwen-proxy): await CDP WebSocket open before sending (InvalidStateError in container)
- chore(qwen-proxy): reword stale qwen.aikit.club comments to chat.qwen.ai (S-M8-95)
- test(qwen-proxy): admin 404 regression with baxiaStatus (S-M7-91)
- feat(qwen-proxy): add Baxia cache-status panel to admin dashboard (S-M7-90)
- docs(qwen-proxy): rewrite README + docker/README for guest-mode/baxia (S-M7-87)
- chore(qwen-proxy): bump shm_size/mem_limit + baxia env (S-M6-84)
- feat(qwen-proxy): add Chromium+fonts to non-root Docker image (S-M6-83)
- chore(qwen-proxy): remove orphaned jose dep (auth.ts JWT was its only consumer; ripped in M5-80b)
- feat(M5-76): guest-only DB schema (api_keys + schema_versions); rewrite migration tests
- refactor(M5-81): rip store/admin + account config; slim repo/admin dashboard; drop account env
- feat(M5-78): adaptive empty-cooldown (markEmptyAndSwitch escalation 90/180/360/600 + markSuccess; 429 flat)
- refactor(M5-80b): rip pool/auth/daemon; retype scheduler to RetryScheduler; adapt tests
- refactor(M5-80a): slim upstream/client.ts to types; drop createUpstreamClient
- refactor(M5-79): collapse RequestThrottle to a single global scalar
- test(M4-73): assert undefined finish_reason → stop_reason end_turn
- test(M4-72): assert finish_reason stop/tool_calls is last frame before [DONE]
- test(qwen-proxy): add M3 real-testing gate (S-M3-5, write-only)
- refactor(qwen-proxy): swap bin to BaxiaTokenManager + GuestUpstreamClient + SingleAccountPool (S-M3-4)
- refactor(qwen-proxy): rip image/video generation + slim AppDeps (S-M3-3)
- refactor(qwen-proxy): widen retry.ts pool→PoolLike + SingleAccountPool test suite (S-M3-2)
- feat(qwen-proxy): add PoolLike interface + SingleAccountPool + tests (S-M3-1)
- fix(qwen-proxy): refresh bx-* headers on rgv587 retry (audit P1)
- test(qwen-proxy): add guest-client smoke test (SMOKE=1 gated, write-only) (S-M2-4)
- feat(qwen-proxy): add chatCompletions (stream/non-stream) + listModels + deleteChats + structural typing (S-M2-3)
- feat(qwen-proxy): add GuestUpstreamClient with createChatSession + normalizeMessages (S-M2-2)
- feat(qwen-proxy): add qwen-sse.ts SSE translator + helpers + recorded fixture (S-M2-1)
- fix(qwen-proxy): resolve spawn function for BaxiaTokenManager (audit P0)
- feat(qwen-proxy): add BaxiaTokenManager smoke test (SMOKE=1 gated, write-only)
- feat(qwen-proxy): add BaxiaTokenManager orchestration (ensureToken cache + single-flight + refresh loop + status)
- feat(qwen-proxy): port BaxiaTokenManager CDP layer with GAP-FIX
- feat(qwen-proxy): add BaxiaConfig to config types and load, adapt test configs
- feat(qwen-proxy): extract upstream types to types.ts with ChatCompletionsBody re-export shim


## [0.1.3] - 2026-08-11
### Changed
- feat(qwen-proxy): look-human throttle + short-cooldown failover for CAPTCHA flags


## [0.1.2] - 2026-08-11
### Changed
- fix(qwen-proxy): retry empty upstream completions instead of silent stop


## [0.1.1] - 2026-08-11
### Changed
- fix(qwen-proxy): accept text/html Content-Type for SSE streams


## [0.1.0] - 2026-08-11
### Changed
- fix(qwen-proxy): flatten multi-turn conversation for qwen.aikit.club
- fix(qwen-proxy): try/catch JSON.parse in injectToolResults + preserve assistant content (audit F1/F3)
- fix(qwen-proxy): strip tool_calls tags in non-stream fallback + flatten content in injectToolResults (review F1/F2/F3)
- feat(qwen-proxy): stream tool-calling integration + cleanup (S-6)
- feat(qwen-proxy): non-stream tool-calling integration + deleteChats cleanup (S-5)
- feat(qwen-proxy): add deleteChats to client + mock updates (S-4)
- feat(qwen-proxy): add tool-stream.ts — ToolStreamDetector state machine (S-3)
- feat(qwen-proxy): add tool-parse.ts — parseToolCalls with regex + lenient fallback (S-2)
- feat(qwen-proxy): add tool-prompt.ts — injectToolPrompt + injectToolResults + prepend (S-1)
- fix(qwen-proxy): widen UpstreamClient interface tools type + add tool_choice (review r2 P3)
- fix(qwen-proxy): forward tool_choice to upstream + tool_calls tests (review r1)
- fix(qwen-proxy): pass through OpenAI function-calling tools (qwen.aikit.club supports them)
- fix(qwen-proxy): strip co-carried content in reasoning/finish stream chunks (audit F3)
- fix(qwen-proxy): tighten D14 sentinel check to avoid false positives (audit F2)
- fix(qwen-proxy): raise non-stream chat + image timeout to 180s (audit F1)
- docs(qwen-proxy): rewrite package READMEs for qwen.aikit.club repoint (S-M5-3)
- feat(qwen-proxy): M4 cleanup + wiring — thin pass-through whole-repo green (S-M4-1/2/4/5/6/7)
- feat(qwen-proxy): drop refreshIntervalMs from config; flip apiUrl default to qwen.aikit.club (S-M4-3)
- feat(qwen-proxy): rewrite anthropic messages for chatCompletions direct (S-M3-2)
- feat(qwen-proxy): rewrite anthropic events for raw OpenAiChatChunk (S-M3-1)
- fix(qwen-proxy): simplify chatCompletions to single union signature + openai adapter tsc fixes (M2 typecheck)
- fix(qwen-proxy): replace createChat/chatCompletionsStream/videoTaskStatus stubs with chatCompletions+videoGeneration (S-M2-4)
- feat(qwen-proxy): rewrite videos adapter as sync (200, no GET/:id) (S-M2-3)
- feat(qwen-proxy): rewrite chat adapter with chatCompletions direct, details-strip, function-calling rejection (S-M2-2)
- feat(qwen-proxy): replace mapChunk with mapOpenAiChunk in OpenAI chunks adapter (S-M2-1)
- feat(qwen-proxy): pool retry re-keyed on OpenAiChatChunk + chatCompletions overload (S-M1-3)
- feat(qwen-proxy): rewrite client as thin OpenAI pass-through (S-M1-2)
- feat(qwen-proxy): details-strip regex + stream stripper (S-M1-1)
- diag(qwen-proxy): dump raw body when chat completion returns non-SSE
- diag(qwen-proxy): log raw SSE events when the completion stream is short
- fix(qwen-proxy): raise streaming-completion timeout so thinking isn't cut
- fix(qwen-proxy): match chat.qwen.ai chat request shape (token cookie + bodies)
- fix(qwen-proxy): send browser-like headers so chat.qwen.ai routes to the API
- fix(qwen-proxy): log unhandled request errors + surface createChat body
- feat(qwen-proxy): parameterize docker host bind + port via env
- fix(qwen-proxy): cap JWT refresh delay at setTimeout 32-bit max
- fix(qwen-proxy): reuse node base image's built-in uid 1000 user in Dockerfile
- fix(qwen-proxy): correct docker-compose build context to repo root
- fix(qwen-proxy): URL-encode admin_key cookie value (audit F3)
- fix(qwen-proxy): align video-jobs totals row colspan dynamically (audit F2)
- fix(qwen-proxy): escape video status in renderUsageSection (XSS, audit F1)
- docs(qwen-proxy): in-package README + root packages-table row (S10 AC)
- feat(qwen-proxy): add Validation (pre-release) section to docker/README.md (S-M2-5)
- feat(qwen-proxy): add docker/README.md — deployment guide mirroring finance-api (S-M2-3)
- feat(qwen-proxy): add docker-compose.yml — qwen-data volume, SF_QWEN_API_KEY required (S-M2-2)
- feat(qwen-proxy): add Dockerfile — multi-stage non-root uid 1000 (S-M2-1)
- chore(qwen-proxy): mark adminKey undefined in test stubs (S-M1-7)
- feat(qwen-proxy): mount admin dashboard at /admin + exports (S-M1-6)
- feat(qwen-proxy): admin dashboard HTML renderers + route handler (S-M1-5)
- feat(qwen-proxy): admin gate middleware — D15 404-when-unset (S-M1-4)
- feat(qwen-proxy): admin store helpers — 7 read-only queries (S-M1-3)
- feat(qwen-proxy): export constantTimeEquals from api-keys.ts (S-M1-2)
- feat(qwen-proxy): add adminKey to QwenProxyConfig (S-M1-1)
- fix(qwen-proxy): video-daemon polls with the task-creator account, not pool-active (audit A5)
- fix(qwen-proxy): return 429 on pre-stream pool exhaustion, not truncated 200 (audit A4)
- fix(qwen-proxy): app.onError maps upstream errors to surface envelopes (audit A3)
- fix(qwen-proxy): reuse pending iter.next() across ping so no chunk is dropped (audit A2)
- fix(qwen-proxy): clear activeId on pool exhaustion so daemon can recover (audit A1)
- fix(qwen-proxy): createChat-in-retry failover, daemon withPoolRetry, unknown-model 400 (impl-review r1)
- feat(qwen-proxy): anthropic POST /v1/messages route + index + app mount (S-M3-3)
- feat(qwen-proxy): anthropic streamAnthropicEvents with thinking blocks, ping, sentinel (S-M3-2)
- feat(qwen-proxy): anthropic errors.ts with envelope re-export from envelopes.ts (S-M3-1)
- feat(qwen-proxy): videos route + createApp(deps) wiring + start/bin (S-M2-13)
- feat(qwen-proxy): POST /v1/images/generations + /v1/images/edits (S-M2-12)
- feat(qwen-proxy): POST /v1/chat/completions stream+non-stream with alias resolution (S-M2-11)
- feat(qwen-proxy): adapters/openai GET /v1/models with aliases + auth gate (S-M2-10)
- feat(qwen-proxy): adapters/openai errors + chunks mappers with envelopes re-export (S-M2-9)
- feat(qwen-proxy): video-daemon.ts background poll with stale+timeout cleanup (S-M2-8)
- feat(qwen-proxy): media/videos.ts submitVideo + getVideoJob with proxy job id (S-M2-7)
- feat(qwen-proxy): video-jobs repo + store re-export (S-M2-6)
- feat(qwen-proxy): media/images.ts size→ratio mapping + generateImage + editImage via pool (S-M2-5)
- feat(qwen-proxy): model aliases parse + resolve with suffix stripping (S-M2-4)
- feat(qwen-proxy): auth gate + error envelopes for both surfaces (S-M2-3)
- feat(qwen-proxy): api-keys store + SF_QWEN_API_KEY env config (S-M2-2)
- feat(qwen-proxy): v10 api_keys + v12 video_jobs migrations (S-M2-1)
- feat(qwen-proxy): pool barrel + bin wiring + shutdown order (S-M1-8)
- feat(qwen-proxy): pool/reenable-daemon.ts periodic cooldown sweep (S-M1-7)
- feat(qwen-proxy): pool/retry.ts withPoolRetry + withPoolRetryStream with D14 sentinel (S-M1-6)
- feat(qwen-proxy): pool/state.ts AccountPool with hydrate/switch/reEnable (S-M1-5)
- feat(qwen-proxy): pool/switch.ts atomicSwitch with double-check + exhaustion (S-M1-4)
- feat(qwen-proxy): add rateLimitCooldownMs + reenableIntervalMs config (S-M1-3)
- feat(qwen-proxy): v11 migration, reconcile inserts disabled (D12), setRateLimit (D13) (S-M1-2)
- feat(qwen-proxy): pool/errors.ts PoolExhaustedError class (S-M1-1)
- fix(qwen-proxy): cookie idempotency, mode-3 validation, refresh mutex/logging, db chmod (audit)
- fix(qwen-proxy): drop password from listAccounts; cover stream fallbacks (impl-review r2)
- fix(qwen-proxy): correct upstream client JSON shapes and stream body (impl-review)
- feat(qwen-proxy): bin LoginFn swap to client.login + index re-export (S-M3-4)
- feat(qwen-proxy): typed upstream client with 8 methods and full error coverage (S-M3-3)
- feat(qwen-proxy): SSE stream parser as async generator (S-M3-2)
- feat(qwen-proxy): 6-category error classifier with classifyResponse (S-M3-1)
- feat(qwen-proxy): bin S2 wiring with db, reconcile, cookies, scheduler (S-M2-8)
- feat(qwen-proxy): auth module with CookieJar, AuthScheduler, and login (S-M2-7)
- feat(qwen-proxy): fingerprint generator and ssxmod cookie generation (S-M2-6)
- feat(qwen-proxy): typed CRUD repo with reconcile cascade (S-M2-5)
- feat(qwen-proxy): openDb with mkdir, foreign_keys, and migrations (S-M2-4)
- feat(qwen-proxy): store schema with 9 migrations and runner (S-M2-3)
- feat(qwen-proxy): account supply modes with zod validation (S-M2-2)
- feat(qwen-proxy): full config surface with scalar defaults (S-M2-1)
- feat(qwen-proxy): config, bin entry, and barrel finalize (S-M1-6)
- feat(qwen-proxy): server start with port handling (S-M1-5)
- feat(qwen-proxy): health endpoint and app (S-M1-4)
- feat(qwen-proxy): logger with extended redaction (S-M1-3)
- feat(qwen-proxy): server errors and openapi-helpers (S-M1-2)
- feat(qwen-proxy): package scaffold (S-M1-1)
