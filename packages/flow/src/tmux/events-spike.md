# tmux Event-Bus Spike (M6, Task 25)

Goal: determine which pi-dynamic-workflows / pi-subagents events fire during a
flow run, their payload shape, and whether a flow extension can subscribe — so
the tmux renderer can open a pane per agent on `created` and close it on a
terminal state.

## Events that fire

`@tintinweb/pi-subagents` emits these (literals found in the dist):

- `subagents:created` — an agent session was created (→ open pane)
- `subagents:ready`
- `subagents:scheduled`
- `subagents:started` — agent began running
- `subagents:steered`
- `subagents:record` — incremental transcript record
- `subagents:compacted`
- `subagents:completed` — terminal: success (→ close pane)
- `subagents:failed` — terminal: failure (→ close pane)

`@quintinshaw/pi-dynamic-workflows` (the orchestration engine) emits its own
lifecycle on a local emitter: `phase`, `log`, `paused`, `resumed`, `stopped`,
`complete`, `error`. The `phase` event maps cleanly to the renderer's per-phase
header (`phase(<id>)`).

Payload shape: each `subagents:*` event carries the agent session `id` (string)
plus context; `subagents:record` carries the incremental record. For pane
open/close we only need the `id`.

## Subscribe path

The `ExtensionAPI.on(...)` overloads (`@earendil-works/pi-coding-agent` v0.76)
register handlers for a fixed set of events (`session_*`, `tool_call`,
`tool_execution_*`, `agent_start/end`, `turn_*`, `message_*`, …). They do **not**
include `subagents:*`. Two viable paths:

1. **Shared EventBus (preferred).** `ExtensionAPI` exposes `events: EventBus`.
   `pi-subagents` emits its events on this shared bus, so
   `pi.events.on("subagents:created", ...)` / `("subagents:completed"|"subagents:failed", ...)`
   should receive them. This is the path the controller wires up; verify the
   exact subscribe signature at integration time (the bus API may be
   `on(type, handler)` or `subscribe(type, handler)`).
2. **Proxy via tool events.** Agent sessions are created through tool calls
   (`tool_execution_start`/`tool_execution_end`). If the EventBus path is
   unavailable in a given runtime, fall back to these as a coarse open/close
   signal.

## Fallback (transcript tail)

If neither event path is available (e.g. a runtime without the bus), tail the
agent transcript files at `.pi/output/agent-<id>.jsonl`: the last record's
status (`completed`/`failed`) indicates a terminal state. This is strictly
worse (polling) and used only when subscription is impossible.

## Decision for M6

The controller (`src/tmux/manager.ts` `createFlowTmuxController`) is built
around the `subagents:created` → open and `subagents:completed`|`subagents:failed`
→ close mapping, with an `emit(event, payload)` entry point so the open/close
logic is unit-testable without a real pi session (see `tests/tmux-events.test.ts`).
Production wiring subscribes via `pi.events` (path 1), with the transcript-tail
fallback documented for runtimes that lack it. `NOOP_WHEN_DISABLED` (renderer)
keeps the whole subsystem a byte-identical no-op when tmux is off
(`SF_FLOW_NO_TMUX=1` or `tmux.enabled=false`).
