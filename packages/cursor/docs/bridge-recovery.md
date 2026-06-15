# Cursor Bridge Recovery

Cursor tool calls pause the upstream native bridge while Pi runs the tool. The provider now recovers tool-result continuations in three tiers:

1. Reuse the live bridge when it is still active.
2. Recover from a stored upstream checkpoint when Cursor emitted one before the tool call pause.
3. Rebuild full history from Pi's request body when this provider recorded a mid-pause tool snapshot but Cursor never emitted a checkpoint.

The full-history rebuild path is intentionally narrow. It requires a provider-recorded mid-pause snapshot, matching session id, matching completed-turn count, matching completed-history fingerprint, fresh mid-pause metadata, and exact one-to-one tool-call/result ids. Fresh requests cannot synthesize a rebuild by posting assistant tool calls and tool results without a prior provider snapshot.

## Resume Idle Behavior

Initial Cursor streams keep the existing idle watchdog:

```sh
PI_CURSOR_STREAM_IDLE_TIMEOUT_MS=120000
PI_CURSOR_STREAM_IDLE_MAX_RETRIES=3
```

Tool-result resume streams use a separate timeout:

```sh
PI_CURSOR_RESUME_IDLE_TIMEOUT_MS=240000
```

Set either timeout to `0` to disable that watchdog while debugging. Positive timeout values below 1000ms are clamped to 1000ms. Resume idle recovery runs before consuming retry budget, so it can rebuild once even when `PI_CURSOR_STREAM_IDLE_MAX_RETRIES=0`.

## Debug Logs

Enable structured debug logs with:

```sh
PI_CURSOR_PROVIDER_DEBUG=1 pi
```

Full-history rebuilds emit:

```json
{
  "event": "native.rebuild_full_history",
  "bridgeKeyPrefix": "01234567",
  "modelId": "gpt-5.4",
  "rebuildReason": "no_checkpoint",
  "completedTurnCount": 0,
  "inFlightTurnHasImages": false,
  "toolResultCount": 1,
  "sentinelInjectionDetected": false
}
```

Legacy chat rebuilds use `chat.rebuild_full_history` with the same fields. Rebuild and recovery-decision logs use `bridgeKeyPrefix` (first 8 hex chars) plus a reason field so a failed continuation can be correlated without logging the full bridge key. Other bridge-lifecycle debug events under `PI_CURSOR_PROVIDER_DEBUG=1` (e.g., `bridge.active_ttl_expired`, `native.stream.abort`, `native.tool_resume.*`) may include the full `bridgeKey` to help operators correlate manually across traces; do not share those log files outside trusted workspaces.

## Metrics

`cursor-provider` does not currently have a package-local telemetry sink. Until one exists, rebuilds emit a metric-style JSON line to stderr and, when `PI_CURSOR_PROVIDER_DEBUG=1` is enabled, the same event is also written to the debug log file:

```json
{
  "event": "metric.cursor_provider.rebuild_full_history",
  "metric": "cursor_provider.rebuild_full_history",
  "reason": "no_checkpoint",
  "model": "gpt-5.4",
  "count": 1
}
```

Production telemetry can consume this event or replace `logFullHistoryRebuild` with a real counter named `cursor_provider.rebuild_full_history{reason,model}`.

## Security Notes

Recovered tool results are wrapped in request-scoped UUID delimiters. If a tool output contains fixed recovery sentinel text, the output is still inert because the active delimiter includes a fresh UUID.

When `sentinelInjectionDetected: true`, the tool output contained text resembling a recovery delimiter. The rebuild is still protected by UUID rotation, but operators should correlate the event with the source tool and inspect whether the output was expected data or prompt-injection content.

Tool-result images are preserved by attaching them to the recovered user message in the rebuilt request.
