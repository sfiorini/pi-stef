---
name: sf-flow-auto
description: Use when a defined flow (global ~/.pi/sf/flow/workflows or project .pi/sf/flow/workflows) must be run end-to-end with no human gates. Input may be a prompt, a markdown file, a PRD, or a Jira story.
---

# sf-flow-auto

## Purpose
Run a defined flow end-to-end, no human gates. Input forms: inline prompt, markdown file, PRD, or Jira story (resolved via @pi-stef/atlassian).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `researcher` agent (matches `researcher.md`). Do NOT use the built-in `Explore` agent (it forces Haiku and cannot access web tools). If no researcher model is configured, omit `model` so it inherits the orchestrator.

Within the generated pi-dw script, each `agent:` phase resolves its agent type by this same rule (a declared agent spawns by name; an undeclared `planner`/`reviewer` falls back to `Plan`/`Reviewer`; anything else → `general-purpose`). `skill:` phases run INLINE: the orchestrator (YOU) reads + executes each skill file in full, dispatches role agents via the Agent tool, writes NO code itself, and spawns NO `general-purpose` subagent for a skill phase.

Models: tier-1 `skill:` phases (sf-flow-plan/implement/audit) **self-resolve** their models from `.pi/sf/flow/config.json` (project then global → `SF_FLOW_<ROLE>_MODEL` env → inherit orchestrator), so a delegated phase honors config just like the direct tool path. The sf_flow_auto tool resolves models (`loadAndResolveDefaults`) and bakes them into the inline `log()` directive as a belt-and-suspenders hint; each tier-1 skill ALSO self-resolves, so a missing or null hint is harmless. Non-tier-1 `agent:` phases use their YAML `model:` (else the `.md`, else the orchestrator).

## Process

### Phase 1: Resolve the flow
The sf_flow_auto tool already resolved the workflow file (project `<repo>/.pi/sf/flow/workflows` overrides global `~/.pi/sf/flow/workflows`), loaded + validated it (`loadFlowYaml`/`validateFlowYaml`), resolved the models (`loadAndResolveDefaults`), and pre-generated the pi-dw script (idempotent) — all included in the tool output. Read the script from the tool output (no need to re-generate or re-validate). If the tool returned a not-found message instead, ask the user to create it via `/sf-flow-create-workflow` or run `/sf-flow-seed` to copy the bundled examples.

### Phase 2: Resolve the input
- `prompt` → use verbatim as the flow's `args.input`
- `md-file` → read the file, pass contents as `args.input`
- `prd` → parse the PRD file, pass as `args.input`
- `jira` → resolve the story via @pi-stef/atlassian (Jira), pass description+acceptance as `args.input`

### Phase 3: Run the flow
Execute the generated pi-dw script with `args.input`. Phases run sequentially; intra-phase fan-out via `parallel()`. Loops (`until_dry` / `until:approved`) run to completion. `skill:` phases run INLINE — you read + execute each skill file in full and dispatch role agents via the Agent tool; do NOT spawn a `general-purpose` subagent for a skill phase.

### Phase 4: Terminal state
Each phase exits success / no-op / blocked / exhausted. On blocked/exhausted, stop and report. No human gates; on completion return the flow's result.

### Phase 5: Telegram
Send a completion summary via notify-telegram.sh.
