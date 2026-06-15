# Bridge Recovery Phase 0 Findings

Captured: 2026-05-21

## Scope

Phase 0 validated the Cursor agent frame ordering around a single MCP tool-call turn before implementing recovery changes. The harness uses the real `cursor-native` provider path, records `PI_CURSOR_PROVIDER_DEBUG` output, and writes sanitized trace fixtures under `tests/fixtures/bridge-frame-traces/`.

## Method

Command shape:

```bash
pnpm exec tsx packages/cursor-provider/scripts/capture-frame-trace.mjs --model <model> --delay-ms <ms> --timeout-ms <ms>
```

The prompt forces one `phase0_echo` MCP tool call. For `composer-2` and `gemini-3.1-pro`, the harness waited 130 seconds before sending the tool result. For `gpt-5.4`, the delay was 1 second because the comparison target was frame ordering, not long-pause survival.

## Results

| Model | Delay before tool result | First `mcpArgs` index | First checkpoint index | `mcpArgs` before checkpoint | Continuation result |
| --- | ---: | ---: | ---: | --- | --- |
| `composer-2` | 130000 ms | 11 | 15 | yes | `stop` |
| `gemini-3.1-pro` | 130000 ms | 15 | 20 | yes | `stop` |
| `gpt-5.4` | 1000 ms | 13 | 17 | yes | `stop` |

Fixtures:

- `tests/fixtures/bridge-frame-traces/composer-2.json`
- `tests/fixtures/bridge-frame-traces/gemini-3.1-pro.json`
- `tests/fixtures/bridge-frame-traces/gpt-5.4.json`

## Conclusion

Phase 0 confirms the ordering hazard: Cursor emits `execServerMessage{mcpArgs}` before the first `conversationCheckpointUpdate` for the tested composer, gemini, and stable comparison routes.

The original plan's narrower model-specific hypothesis is incomplete. The observed ordering is not unique to composer/gemini, so a `PI_CURSOR_REBUILD_ON_FIRST_LOSS_FOR=composer*,gemini*` override is not justified by this evidence. The fix should be general:

1. Record metadata-only mid-pause snapshots immediately when `mcpArgs` arrives, even when no checkpoint has arrived yet.
2. Also commit a later checkpoint to the stored conversation if it arrives after the tool pause while the bridge remains alive.
3. Use full-history rebuild when the live bridge is unavailable and checkpoint recovery cannot proceed.
4. Keep model-specific resilience tuning out of the default path unless future traces show a model-specific failure beyond the shared ordering.

The long-delay runs did not reproduce bridge loss: both `composer-2` and `gemini-3.1-pro` kept sending upstream heartbeats and resumed successfully after 130 seconds. The original production reports did not include a controlled network/account/region matrix, so this absence of live repro is only evidence that bridge loss is intermittent under the Phase 0 harness conditions. The implementation tests still need deterministic simulated bridge-loss fixtures rather than relying on live upstream instability.
