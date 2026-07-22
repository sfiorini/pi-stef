---
name: sf-flow-seed
description: Use when flow's default agents and example workflows must be copied to their global locations — re-runnable, never clobbers user edits (writes <name>.new for changed files).
---

# sf-flow-seed

## Purpose
Copy flow's bundled defaults to their GLOBAL locations so they're available in every project:
- 8 agents → `~/.pi/agent/agents/` (reviewer, designer, auditor, planner, developer, synth, scanner, researcher)
- 4 example workflows → `~/.pi/sf/flow/workflows/` (code-review, ship-feature, auth-audit, research-report)

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
- Agent `reviewer.md` is shared with `@pi-stef/pair`; whichever was written first wins. If flow's version differs from pair's, `/sf-flow-seed` surfaces flow's version as `<name>.new` so you can compare. Flow no longer ships `explorer.md` (consolidated into `researcher.md`, non-isolated, web-capable); pair still ships its own `explorer.md`. To adopt flow's researcher, delete any old seeded `explorer.md` and re-seed.
- This is GLOBAL seeding. A project can override a global default by placing `<repo>/.pi/sf/flow/workflows/<name>.yaml`.
