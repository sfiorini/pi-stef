# Cursor SDK API Reference

This provider uses the `@cursor/sdk` local-agent mode to communicate with Cursor. All transport, streaming, and reconnection logic is handled by the SDK — this document covers the API surface used by the provider.

## `@cursor/sdk` API Surface

### Agent Lifecycle

```typescript
import { Agent, Cursor } from "@cursor/sdk";

// Create a new agent session
const agent = await Agent.create({
  apiKey,
  local: { cwd, enableAgentRetries: true }, // pi tools exposed as in-process customTools per agent.send
  // optional: cwd, model selection, etc.
});

// Resume an existing agent session
const agent = await Agent.resume(agentId, { apiKey });
```

### Streaming

```typescript
// Send a message and receive streamed updates
const run = agent.send(payload, {
  onDelta: (update: InteractionUpdate) => { /* handle streaming deltas */ },
  onStep:  (step: ConversationStep)  => { /* handle step completions */ },
});

// Wait for the run to complete
const { result, usage, stopReason } = await run.wait();

// Cancel an in-progress run
run.cancel();
```

### Model Discovery

```typescript
// List available models for an API key
const models = await Cursor.models.list({ apiKey });
```

### HTTP/1.1 Configuration

```typescript
// Force HTTP/1.1 transport (for VPN/proxy environments)
Cursor.configure({
  local: { useHttp1ForAgent: true },
});
```

## Event Mapping

### `InteractionUpdate` → Pi Events

| SDK `update.type` | Pi Event |
|---|---|
| `text-delta` | `text_delta` (auto `text_start` on first delta) |
| `thinking-delta` | `thinking_delta` (auto `thinking_start`) |
| `thinking-completed` | `thinking_end` |
| `tool-call-started` | `toolcall_start` + `toolcall_delta` (JSON args) |
| `tool-call-completed` | `toolcall_end` + `writer.done("toolUse")` (if pi tool) |
| `shell-output-delta` | `thinking_delta` |
| `turn-ended` | Record usage metadata |

### `ConversationStep` → Pi Events

| SDK step type | Pi Event |
|---|---|
| `toolCall` | `toolcall_end` (deduplicated vs delta via fingerprint ledger) |

### Usage Resolution

Usage is resolved in priority order:
1. Per-turn `turn-ended` update from `onDelta`
2. `run.wait()` result usage
3. Character-based estimation (chars / 4)

### Stop Reason Mapping

| SDK stop reason | Pi stop reason |
|---|---|
| `completed` | `stop` |
| Tool pause | `toolUse` |
| `length` | `length` |
| Error | `error` |

## Tool Exposure — In-Process `customTools`

Pi tools are exposed to the Cursor agent as **in-process callback tools** via
`@cursor/sdk`'s `customTools` (passed per `agent.send({ local: { customTools } })`).
The SDK registers them as a synthetic `custom-user-tools` MCP server, so the model
discovers and invokes them through the same MCP meta-tool path as any other server
(`GetMcpTools` / `CallMcpTool`) — but the calls are satisfied by in-process
callbacks in this provider. There is **no loopback HTTP server and no
`127.0.0.1:0` socket**.

Cross-turn continuation:
1. `src/tool-bridge.ts` `buildCustomTools()` wraps each pi tool as a `pi__<name>`
   custom tool whose `execute()` emits pi `toolcall_*` events (via the
   turn-coordinator) and returns the bridge's pending promise.
2. The deferred is keyed by the tool call id and resolves when a later pi turn
   supplies the tool result via `resolveFromToolResults`.
3. When a tool parks, the stream ends with `done("toolUse")`; the next pi turn
   RESUMEs the same SDK run and resolves the pending call(s). Abort cancels the
   run and rejects pending calls.

## Model Discovery Flow

`discoverModels({ forceRefresh })` resolves models in priority order (the API key
is resolved internally — stored cred → `CURSOR_API_KEY` → none):

1. **Cache** — Check `~/.pi/agent/cursor-sdk-model-list.json` (TTL 24h, keyed by `sha256(apiKey)[:16]`, mode 0600). *Skipped when `forceRefresh` is set.*
2. **Live** — Call `Cursor.models.list({ apiKey })`, save to cache
3. **Stale cache** — Use expired cache if live call fails
4. **Fallback** — Use bundled `FALLBACK_MODEL_ITEMS` from `model-fallback.generated.ts`

`/cursor-refresh-models` runs `discoverModels({ forceRefresh: true })` so the live
API is always called (bypassing the cache). On success it overwrites the cache and
re-registers the provider models in-memory, so a newly added model is available
immediately without restarting pi. If the live call fails it leaves the in-memory
list untouched and warns.

## Agent Pooling

Agents are pooled with a 4-dimensional key: `scopeKey + cwd + modelSelection + sha256(apiKey)[:16] + bridgeSurfaceSignature`.

- **Acquire** — Returns an idle agent or creates a new one
- **Release** — Returns agent to pool for reuse
- **Dispose** — Tears down agent (dead transport, session cleanup)
- Turns within a scope are serialized (no concurrent sends)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CURSOR_API_KEY` | — | Cursor API key |
| `PI_CURSOR_HTTP_1_1` | — | Force HTTP/1.1 transport (truthy: `1`/`true`/`on`/`yes`/`enabled`) |
| `PI_CURSOR_DISABLE_MODEL_CACHE` | — | Disable 24h model disk cache |
| `PI_CURSOR_MODEL_CACHE_TTL_MS` | `86400000` | Model cache TTL in ms |
| `PI_CURSOR_PROVIDER_DEBUG` | — | Enable debug logging |
