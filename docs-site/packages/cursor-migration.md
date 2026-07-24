# Cursor Migration Guide (0.2.x → 0.3.0)

Version 0.3.0 is a **breaking release** that replaces the reverse-engineered protobuf/HTTP2 bridge with the official `@cursor/sdk` local-agent mode. This guide covers everything you need to update.

## Breaking Changes

### 1. Authentication: OAuth → API Key

The browser-based OAuth login flow has been replaced with API key authentication.

**Before (0.2.x):**
```sh
/login cursor
# Opens browser → OAuth authorize → tokens stored
```

**After (0.3.0):**
```sh
# Option A: environment variable
export CURSOR_API_KEY=crsr_…

# Option B: stored credential
/cursor-login crsr_…
```

Get your API key from [cursor.com/dashboard](https://cursor.com/dashboard) → **Settings** → **API Keys**.

::: warning
Old OAuth credentials stored by `/login cursor` are automatically detected and a migration warning is printed at startup. They are not used — you must create and configure a new API key.
:::

### 2. `api` Field Changed

If you reference the cursor provider API field in configuration, update from `cursor-native` to `cursor-sdk`.

### 3. Node.js ≥ 22.14 Required

The minimum Node.js version has been raised from 20 to **22.14**. This is required by `@cursor/sdk`.

### 4. Removed Environment Variables

The following environment variables are no longer used and should be removed from your shell profile or configuration:

| Removed Variable | Reason |
|---|---|
| `PI_CURSOR_TRANSPORT` | Transport is now handled by `@cursor/sdk` |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` | Idle watchdog is handled by the SDK |
| `PI_CURSOR_STREAM_IDLE_MAX_RETRIES` | Idle retry logic is handled by the SDK |
| `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS` | Resume timeout is handled by the SDK |
| `CURSOR_ACCESS_TOKEN` | OAuth access token (no longer used) |
| `PI_CURSOR_CLIENT_VERSION` | Client version header (no longer used) |
| `PI_CURSOR_AGENT_URL` | Agent endpoint (SDK resolves internally) |
| `CURSOR_AGENT_URL` | Agent endpoint (SDK resolves internally) |

### 5. Removed Features

- **Transport selection** (`PI_CURSOR_TRANSPORT=child`) — The child-process bridge is removed. The SDK handles all transport internally.
- **Bridge recovery** — The three-tier bridge recovery (resume/rebuild/recreate) is removed. The SDK handles transport resilience, and conversation recovery uses full-context bootstrap from Pi's transcript.
- **Idle watchdog tuning** — The stream idle timeout and retry environment variables are removed. The SDK manages connection health internally.

## Kept Environment Variables

These variables continue to work in 0.3.0:

| Variable | Description |
|---|---|
| `CURSOR_API_KEY` | Cursor API key |
| `PI_CURSOR_HTTP_1_1` | Force HTTP/1.1 transport (useful for VPN/proxy) |
| `PI_CURSOR_DISABLE_MODEL_CACHE` | Disable the 24h model disk cache |
| `PI_CURSOR_MODEL_CACHE_TTL_MS` | Override the model cache TTL |
| `PI_CURSOR_PROVIDER_DEBUG` | Enable debug logging |

## New Features in 0.3.0

- **Model discovery via SDK** — Uses `Cursor.models.list` with a 24-hour disk cache. Models are automatically discovered after API key authentication.
- **Agent pooling** — Agents are pooled and reused across turns for the same model/key combination, improving performance.
- **Agent retries** — Configurable via `enableAgentRetries` in provider options.
- **Official transport** — All streaming, reconnection, and transport logic uses the official `@cursor/sdk`, eliminating the custom protobuf/HTTP2 bridge.

## Migration Checklist

1. [ ] Update Node.js to ≥ 22.14
2. [ ] Create an API key at [cursor.com/dashboard](https://cursor.com/dashboard) → **Settings** → **API Keys**
3. [ ] Set `CURSOR_API_KEY` or run `/cursor-login <key>` in Pi
4. [ ] Remove deprecated environment variables from your shell profile
5. [ ] Update any config references from `api: "cursor-native"` to `api: "cursor-sdk"`
6. [ ] Update `@pi-stef/cursor` to `^0.3.0` and run `pi install`
7. [ ] Run `/cursor-refresh-models` to rebuild the model cache with your new key
