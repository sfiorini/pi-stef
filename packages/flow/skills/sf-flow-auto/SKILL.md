---
name: sf-flow-auto
description: Use when a defined flow (global ~/.pi/sf/flow/workflows or project .pi/sf/flow/workflows) must be run end-to-end with no human gates. Input may be a prompt, a markdown file, a PRD, or a Jira story.
---

# sf-flow-auto

## Purpose
Run a defined flow end-to-end, no human gates. Input forms: inline prompt, markdown file, PRD, or Jira story (resolved via @pi-stef/atlassian).

## Process

### Phase 1: Resolve the flow
The sf_flow_auto tool already resolved the workflow file (project `<repo>/.pi/sf/flow/workflows` overrides global `~/.pi/sf/flow/workflows`) and passed its absolute path in the tool output — read that file. Validate it (`validateFlowYaml`). Generate the pi-dw script (idempotent). If the tool returned a not-found message instead, ask the user to create it via `/sf-flow-create-workflow` or run `/sf-flow-seed` to copy the bundled examples.

### Phase 2: Resolve the input
- `prompt` → use verbatim as the flow's `args.input`
- `md-file` → read the file, pass contents as `args.input`
- `prd` → parse the PRD file, pass as `args.input`
- `jira` → resolve the story via @pi-stef/atlassian (Jira), pass description+acceptance as `args.input`

### Phase 3: Run the flow
Execute the generated pi-dw script with `args.input`. Phases run sequentially; intra-phase fan-out via `parallel()`. Loops (`until_dry` / `until:approved`) run to completion.

### Phase 4: Terminal state
Each phase exits success / no-op / blocked / exhausted. On blocked/exhausted, stop and report. No human gates; on completion return the flow's result.

### Phase 5: Telegram
Send a completion summary via notify-telegram.sh.
