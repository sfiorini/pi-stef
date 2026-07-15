# @pi-stef/flow

Reusable multi-agent workflows, CodeRabbit-style code audit, and tmux agent visualization for the Pi coding agent. Built on `@tintinweb/pi-subagents` + `@quintinshaw/pi-dynamic-workflows`.

## Install

```bash
pi install npm:@pi-stef/flow
```

## Commands

| Command | Purpose |
|---|---|
| `sf_flow_plan` | Multi-milestone plan with parallel research + iterative review |
| `sf_flow_implement` | Execute a plan: 1 worktree, TDD per story, audit gate before commit |
| `sf_flow_audit` | CodeRabbit-style audit (7 angles + dual-blind AND-gate + fix-apply) |
| `sf_flow_auto <name> <input>` | Run a defined flow end-to-end, no human gates |
| `sf_flow_create_workflow` | Wizard: interview → agents/phases/loops YAML → `/<name>` |

## Reusable flows (the 3-knob model)

Define a flow in `.pi/workflows/<name>.yaml` with three knobs — **agents**, **phases**, **loops** — then run `sf_flow_auto <name> <input>`:

```yaml
name: my-flow
description: ...
input: prompt   # prompt | md-file | prd | jira
agents:
  worker:
    tools: [read, grep, find]
    model: haiku
phases:
  - id: do
    agent: worker
    prompt: "..."
    out: result
loops: {}       # optional: until_dry or until:approved
```

A phase runs **exactly one** of `agent` / `skill` / `raw`. See `packages/flow/templates/workflow.yaml` and `packages/flow/workflows/` for working examples (`auth-audit`, `ship-feature`, `code-review`, `research-report`). Full docs: `docs-site/packages/flow.md`.

## Code audit triad

`sf_flow_audit` runs the bigpowers triad, returning P0–P3 findings + a verdict (`APPROVED`/`REVISE`):

1. **pi-dw `/code-review`** — 7 finder angles (A/B/C correctness, D/E/F cleanup, G altitude), verified + deduped.
2. **audit-code** — 10-section self-checklist; `--gate` exits 1 on any failure.
3. **request-review** — dual-blind AND-gate: two independent reviewers must both pass (score ≥ threshold, no must-fix); bounded by `audit.max_rounds` (5).
4. **respond-review** — categorize (must-fix / should-fix / consider) + apply in severity order.

## Config

`~/.pi/sf/flow/config.json` or `<repo>/.pi/sf/flow/config.json` (partial configs are fine — defaults fill in):

```json
{
  "reviewer": { "model": "anthropic/sonnet-4-6" },
  "audit": { "threshold": 0.94, "max_rounds": 5 },
  "tmux": { "enabled": true, "theme": "codex" },
  "worktree": { "branch_prefix": "flow/" }
}
```

Env: `SF_FLOW_REVIEWER_MODEL`, `SF_FLOW_EXPLORER_MODEL`, `SF_FLOW_NO_TMUX=1`.

## Agents

Six write-once agents are ensured at `~/.pi/agent/agents/`: `reviewer`, `explorer`, `auditor`, `planner`, `developer`, `synth`. Edit them freely — flow never overwrites an existing file.
