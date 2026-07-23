# @pi-stef/cursor

Cursor AI editor as a native Pi stream provider — OAuth login, protobuf/HTTP2 protocol, tool-call recovery.

## Overview

This package registers Cursor as a Pi provider named `cursor`. It enables Pi to use Cursor models (Claude, GPT, Gemini, Grok) through Cursor OAuth and Cursor's native agent protocol.

Key features:
- OAuth PKCE authentication with Cursor
- Protobuf/HTTP2 protocol for efficient streaming
- Three-tier bridge recovery for tool-call continuity
- Exact model routing (no invented reasoning-effort suffixes)
- Dynamic agent endpoint resolution

## Install

```sh
pi install npm:@pi-stef/cursor
```

Then open Pi and run:

```text
/login cursor
```

## Usage

After installing and logging in, ask Pi to use Cursor-backed models:

```text
"Use the cursor provider for this session and compare the failing test output with the latest diff."
"Use Cursor MAX mode through the cursor provider for this larger refactor."
"Use the cursor provider with the exact gemini-3.1-pro model; do not force a reasoning level unless Cursor advertises one."
```

## Remove

```sh
pi remove @pi-stef/cursor
```

## Update

```sh
pi update @pi-stef/cursor
```

## Endpoint And Model Routing

Cursor model discovery and streaming use Cursor's agent endpoint. The provider resolves that endpoint in this order:

1. `PI_CURSOR_AGENT_URL`
2. `CURSOR_AGENT_URL`
3. Cursor CLI config at `~/.cursor/cli-config.json`, from `serverConfigCache.agentUrlConfig.agentnUrl` or `serverConfigCache.agentUrlConfig.agentUrl`
4. Fallback `https://agentn.us.api5.cursor.sh`

Use an environment override only when Cursor has moved your account or region to a different agent endpoint:

```sh
PI_CURSOR_AGENT_URL="https://agentn.us.api5.cursor.sh" pi
```

The provider sends exact Cursor model ids without inventing reasoning-effort suffixes. If a model is listed as an exact non-effort model, a Pi reasoning request such as `high` is omitted instead of turning `gemini-3.1-pro` into a fake `gemini-3.1-pro-high` route. Reasoning effort is forwarded only when Cursor model metadata advertises effort support or provides an explicit mapping.

Parameterized and MAX variants still route through Cursor metadata. Native agent model discovery uses the resolved agent endpoint; legacy parameterized model discovery is used only when Cursor's older available-models endpoint returns it.

## Architecture

### Transport

The default transport is an **in-process Connect client** (`src/connect-transport.ts`)
over Node's `http2` (HTTP/2), with an **HTTP/1.1+SSE fallback** selected by
`PI_CURSOR_HTTP_1_1=1`. Both speak the same Connect framing as the legacy child
bridge, so OAuth, model routing, and tool-call recovery are unchanged. This
replaces the older hand-rolled HTTP/2 **child-process bridge** (`h2-bridge.mjs`),
which hard-exited on idle/errors and had no fallback — an obsolete workaround
now that Pi requires **Node 22.19+** (so `node:http2` runs in-process).

The in-process transport also **classifies stream errors** (auth / transient /
fatal), sends an **HTTP/2 PING keepalive** every 30s (without extending the
application idle watchdog), propagates **`AbortSignal`** to tear down the upstream
stream, and **retries once** on an auth-classified close by refreshing the OAuth
token.

The legacy child-process bridge remains available as a deprecated escape hatch:

```sh
PI_CURSOR_TRANSPORT=child pi
```

### Bridge Recovery

The provider implements three-tier bridge recovery for tool-call continuity:

1. **Tier 1**: Resume from existing bridge connection
2. **Tier 2**: Rebuild from checkpoint/blob state
3. **Tier 3**: Full history rebuild from Pi request context

See [bridge recovery docs](docs/bridge-recovery.md) for details.

### Protocol

The provider uses protobuf over HTTP/2 (or HTTP/1.1+SSE) for efficient
communication with Cursor's agent endpoint. See [protocol docs](src/docs/protocol.md)
for details.

## Configuration

### Environment Variables

- `PI_CURSOR_AGENT_URL` — Override Cursor agent endpoint
- `CURSOR_AGENT_URL` — Alternative agent endpoint override
- `PI_CURSOR_TRANSPORT` — Transport selection: default `connect` (in-process); `child` selects the deprecated child-process bridge. Unknown values fall through to the in-process transport.
- `PI_CURSOR_HTTP_1_1` — Force the HTTP/1.1+SSE transport. Truthy: `1`/`true`/`on`/`yes`/`enabled` (case/whitespace-insensitive); everything else (including unknown values) leaves the default HTTP/2 transport. Independent of `PI_CURSOR_TRANSPORT`; the child bridge does not read it.
- `PI_CURSOR_PROVIDER_DEBUG=1` — Enable debug logging
- `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` — Stream idle timeout (default: 120000ms; `0` disables the watchdog as an immediate diagnostic)
- `PI_CURSOR_STREAM_IDLE_MAX_RETRIES` — Max idle retries (default: 3)
- `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS` — Resume stream timeout (default: 240000ms)

### Debug Logging

```sh
PI_CURSOR_PROVIDER_DEBUG=1 pi
```

Debug summaries redact token-like values and image payload bytes. Logs are intended for protocol debugging, not for sharing outside a trusted workspace.

## Troubleshooting

### Authentication Fails

Remove the package and reinstall after updating Pi:

```sh
pi remove @pi-stef/cursor
pi install npm:@pi-stef/cursor
```

### Provider Starts Offline

If the provider starts offline, it registers bundled fallback models and retries live model discovery after successful OAuth login or refresh.

### Stream Idle Timeout

Native streams retry in place when Cursor stops sending upstream data. The default idle timeout is 2 minutes, outbound heartbeat frames do not extend it, and the provider retries 3 times before returning a final error. The default can spend up to 8 minutes on a fully silent turn, and each retry may repeat upstream Cursor work.

### Connection drops / "lost connection to the upstream provider"

If streams fail mid-turn (the symptom this transport rewrite targets), try in
order:

1. `PI_CURSOR_HTTP_1_1=1 pi` — switch to the HTTP/1.1+SSE transport (the proven
   escape hatch for VPN/proxy/broken-HTTP2 environments; mirrors `@cursor/sdk`'s
   `useHttp1ForAgent`).
2. `PI_CURSOR_TRANSPORT=child pi` — fall back to the deprecated child-process
   bridge (logs `transport.deprecated_child` under `PI_CURSOR_PROVIDER_DEBUG=1`).
3. `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS=0 pi` — disable the idle watchdog as an
   immediate diagnostic (note: this removes the in-place idle retry too).

#### Why not an OpenAI-compatible endpoint?

There is **no first-party Cursor-hosted OpenAI-compatible chat endpoint**; the
community `/v1/chat/completions` proxies all ride the **same Cursor
protobuf-over-HTTP2 wire** this package already speaks, so they add a proxy
dependency and a new failure surface rather than improving reliability. A full
`@cursor/sdk` agent-loop mode (Dashboard API key + Cursor's own tools) is a
possible future direction but changes auth and Pi's execution model, so it is
deferred.

## Live Verification

The repo tests do not require Cursor credentials. To smoke-test with a real account after installing:

1. Start Pi.
2. Run `/login cursor`.
3. Select a Cursor model from `/model`.
4. Send a simple text prompt.
5. Send a prompt with a small PNG/JPEG if image support is needed.

## Upstream Attribution

This package adapts `ndraiman/pi-cursor-provider` PR #8 at pinned commit `06c894e76989cb961c65c6b48914d12fe26cf90b`, authored by Matthew Leong. The upstream repo is by Netanel Draiman and is MIT licensed.

Additional protocol and model-quality references:
- `sudosubin/pi-frontier` by Subin Kim
- `netandreus/pi-cursor-provider` by Andrey
- `kenryu42/pi-cursor-oauth`
