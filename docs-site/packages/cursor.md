# Cursor Provider

Cursor AI editor as a native Pi stream provider — powered by `@cursor/sdk` local-agent mode with API-key authentication.

## Overview

The Cursor provider registers Cursor as a Pi provider named `cursor`. It enables Pi to use Cursor models (Claude, GPT, Gemini, Grok) through the official `@cursor/sdk` local-agent mode with API-key authentication.

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

## Model Discovery and Routing

The provider discovers available models from Cursor via `Cursor.models.list` and preserves exact model IDs. The discovered model list is cached to disk for 24 hours. If live discovery fails, a bundled fallback list is used.

Reasoning effort is forwarded only when Cursor model metadata advertises effort support.

## Architecture

The provider uses the official `@cursor/sdk` to manage local Cursor agents. All streaming, transport, and reconnection logic is handled by the SDK.

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

## Slash Commands

| Command | Description |
|---------|-------------|
| `/cursor-login <key>` | Store a Cursor API key (persists across restarts) |
| `/cursor-refresh-models` | Re-discover Cursor models and update the cache |

## Troubleshooting

### Invalid API key (401)

Your API key is invalid or has been revoked. Create a new key at [cursor.com/dashboard](https://cursor.com/dashboard) → **Settings** → **API Keys**, then run `/cursor-login <new-key>` or update `CURSOR_API_KEY`.

### Rate limits

Cursor may rate-limit requests. If you see rate-limit errors, wait a few minutes before retrying.

### Model not found after key rotation

If you rotate your API key and see model-not-found errors, the cached model list may be stale. Run `/cursor-refresh-models` and restart Pi to rebuild the cache.

### Network / proxy issues

If you're behind a corporate proxy or VPN that breaks HTTP/2 streams, force HTTP/1.1 mode:

```sh
PI_CURSOR_HTTP_1_1=1 pi
```

## Migration

Upgrading from 0.2.x? See the [Migration Guide](/packages/cursor-migration) for breaking changes (auth, removed env vars, Node requirement).

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
