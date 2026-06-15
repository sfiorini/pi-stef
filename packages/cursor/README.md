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

### Bridge Recovery

The provider implements three-tier bridge recovery for tool-call continuity:

1. **Tier 1**: Resume from existing bridge connection
2. **Tier 2**: Rebuild from checkpoint/blob state
3. **Tier 3**: Full history rebuild from Pi request context

See [bridge recovery docs](docs/bridge-recovery.md) for details.

### Protocol

The provider uses protobuf over HTTP/2 for efficient communication with Cursor's agent endpoint. See [protocol docs](src/docs/protocol.md) for details.

## Configuration

### Environment Variables

- `PI_CURSOR_AGENT_URL` — Override Cursor agent endpoint
- `CURSOR_AGENT_URL` — Alternative agent endpoint override
- `PI_CURSOR_PROVIDER_DEBUG=1` — Enable debug logging
- `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` — Stream idle timeout (default: 120000ms)
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
