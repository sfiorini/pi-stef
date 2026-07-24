# @pi-stef/cursor

Cursor AI editor as a native Pi stream provider — powered by `@cursor/sdk` local-agent mode with API-key authentication.

## Overview

This package registers Cursor as a Pi provider named `cursor`. It enables Pi to use Cursor models (Claude, GPT, Gemini, Grok) through the official `@cursor/sdk` local-agent mode with API-key authentication.

Key features:
- API-key authentication (no browser login required)
- Official `@cursor/sdk` local-agent mode for reliable streaming
- Automatic model discovery with 24h disk cache and bundled fallback
- Exact model routing (no invented reasoning-effort suffixes)
- Agent pooling with cross-turn tool-call continuity
- HTTP/1.1 fallback for VPN/proxy environments

## Quick Start

### 1. Get an API key

Visit [cursor.com/dashboard](https://cursor.com/dashboard) → **Settings** → **API Keys** and create a key.

### 2. Install

```sh
pi install npm:@pi-stef/cursor
```

### 3. Authenticate

Choose **one** of:

```sh
# Option A: environment variable (works immediately)
export CURSOR_API_KEY=crsr_…

# Option B: stored credential (persists across restarts)
/cursor-login crsr_…
```

Then use any Cursor-backed model in a prompt.

## Usage

After installing and logging in, ask Pi to use Cursor-backed models:

```text
"Use the cursor provider for this session and compare the failing test output with the latest diff."
"Use Cursor MAX mode through the cursor provider for this larger refactor."
"Use the cursor provider with the exact gemini-3.1-pro model; do not force a reasoning level unless Cursor advertises one."
```

## Architecture

The provider uses the official `@cursor/sdk` to manage local Cursor agents. All streaming, transport, and reconnection logic is handled by the SDK.

```
extensions/cursor.ts → src/index.ts (registerProvider + slash cmds)
  ├─ src/sdk-stream.ts (streamSimple entry; exports streamCursorLazy)
  │   ├─ src/api-key.ts
  │   ├─ src/context-builder.ts
  │   ├─ src/turn-coordinator.ts
  │   ├─ src/session-agent.ts ─► src/sdk-runtime.ts
  │   └─ src/provider-errors.ts
  ├─ src/model-discovery.ts ─► src/model-cache.ts (adapted)
  └─ src/sensitive-text.ts
```

**Request flow:** `streamSimple(model, context, options)` → resolve API key → acquire pooled agent → build prompt + expose pi tools → `agent.send({onDelta, onStep})` → map to pi event stream → `run.wait()` / `run.cancel()`.

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CURSOR_API_KEY` | Cursor API key (alternative to `/cursor-login`) |
| `PI_CURSOR_HTTP_1_1` | Force HTTP/1.1 transport. Truthy: `1`/`true`/`on`/`yes`/`enabled` (case/whitespace-insensitive). Useful for VPN/proxy environments. |
| `PI_CURSOR_DISABLE_MODEL_CACHE` | Disable the 24h model disk cache |
| `PI_CURSOR_MODEL_CACHE_TTL_MS` | Override the model cache TTL (default: 24h) |
| `PI_CURSOR_PROVIDER_DEBUG` | Enable debug logging (`1` to activate) |

### Debug Logging

```sh
PI_CURSOR_PROVIDER_DEBUG=1 pi
```

Debug summaries redact token-like values and image payload bytes. Logs are intended for protocol debugging, not for sharing outside a trusted workspace.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/cursor-login <key>` | Store a Cursor API key (persists across restarts) |
| `/cursor-refresh-models` | Re-discover Cursor models and update the cache |

## Troubleshooting

### Invalid API key (401)

Your API key is invalid or has been revoked. Create a new key at [cursor.com/dashboard](https://cursor.com/dashboard) → **Settings** → **API Keys**, then run `/cursor-login <new-key>` or update `CURSOR_API_KEY`.

### Rate limits

Cursor may rate-limit requests. If you see rate-limit errors, wait a few minutes before retrying. Consider reducing request frequency for large refactors.

### Model not found after key rotation

If you rotate your API key and see model-not-found errors, the cached model list may be stale. Run `/cursor-refresh-models` and restart Pi to rebuild the cache.

### Network / proxy issues

If you're behind a corporate proxy or VPN that breaks HTTP/2 streams, force HTTP/1.1 mode:

```sh
PI_CURSOR_HTTP_1_1=1 pi
```

## Migration

Upgrading from 0.2.x? See the [Migration Guide](/pi-stef/packages/cursor-migration) for breaking changes (auth, removed env vars, Node requirement).

## Remove

```sh
pi remove @pi-stef/cursor
```

## Update

```sh
pi update @pi-stef/cursor
```

## Live Verification

The repo tests do not require Cursor credentials. To smoke-test with a real account after installing:

1. Start Pi.
2. Run `/cursor-login <your-key>` or set `CURSOR_API_KEY`.
3. Select a Cursor model from `/model`.
4. Send a simple text prompt.
5. Send a prompt with a small PNG/JPEG if image support is needed.

## Upstream Attribution

This package adapts `ndraiman/pi-cursor-provider` PR #8 at pinned commit `06c894e76989cb961c65c6b48914d12fe26cf90b`, authored by Matthew Leong. The upstream repo is by Netanel Draiman and is MIT licensed.

Powered by `@cursor/sdk` (MIT, Cursor Inc.) and [pi-cursor-sdk](https://github.com/nicepkg/pi-cursor-sdk) (MIT, Mitch Fultz).

Additional protocol and model-quality references:
- `sudosubin/pi-frontier` by Subin Kim
- `netandreus/pi-cursor-provider` by Andrey

## License

MIT
