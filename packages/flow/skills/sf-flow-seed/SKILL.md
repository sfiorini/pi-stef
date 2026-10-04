---
name: sf-flow-seed
description: Use when flow's default agents and example workflows must be copied to their global locations — re-runnable, never clobbers user edits (writes <name>.new for changed files).
---

# sf-flow-seed

## Purpose
Copy flow's bundled defaults to their GLOBAL locations so they're available in every project:
- 12 agents → the global agents dir (`getAgentDir()/agents/`, default `~/.pi/agent/agents/`, honoring `PI_CODING_AGENT_DIR`): reviewer, designer, auditor, planner, developer, synth, scanner, researcher, elicitor, notifier, explorer, analyst
- 5 example workflows → `~/.pi/sf/flow/workflows/` (code-review, ship-feature, auth-audit, research-report, deep-research)

Every shipped agent `.md` pins `model: anthropic/claude-sonnet-5-5` as an explicit, user-editable default — edit each file to your preferred model (full `provider/modelId`); flow never passes a model at dispatch.

## Behavior (per file)
- missing → write the bundled default
- byte-identical → up-to-date (no-op)
- differs → write the new default as `<name>.new` beside the user's file (the user's file is never overwritten)

Idempotent: a repeat run reports everything up-to-date (and refreshes any stale `<name>.new` to the latest bundled version).

## After seeding
- The example workflows are runnable immediately via `sf_flow_auto <name>`, and register as `/<name>` slash commands (`/code-review`, …) at the next pi restart (load-time discovery).
- Agents are discovered by pi-subagents globally.
- To review a changed default: `diff reviewer.md reviewer.md.new`, merge what you want, then delete the `.new`.

## Notes
- Agent `reviewer.md` is shared with earlier workflow packages; whichever was written first wins. If flow's version differs, `/sf-flow-seed` surfaces flow's version as `<name>.new` so you can compare.
- `explorer.md` and `analyst.md` ship with flow again (the deep-research flow's agents; explorer is the fast read-only scout, analyst the intake/synthesis writer). An old seeded `explorer.md` from an earlier package may shadow flow's — re-seed and compare the `.new` to adopt flow's definition.
- This is GLOBAL seeding. A project can override a global default by placing `<repo>/.pi/sf/flow/workflows/<name>.yaml` (workflows) or `<repo>/.pi/agents/<name>.md` (agents).
