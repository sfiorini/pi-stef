# flow

Reusable multi-agent workflows, CodeRabbit-style code audit, and tmux agent visualization.

## Overview

`flow` unifies `pair`'s plan/implement/review simplicity with `@quintinshaw/pi-dynamic-workflows`' dynamic orchestration and the bigpowers audit rigor, plus tmux agent visualization adapted from `team`. It coexists with `pair` and will eventually deprecate `team`.

Two tiers:
- **Tier 1 — built-in prose skills** (`sf-flow-plan` / `sf-flow-implement` / `sf-flow-audit` / `sf-flow-auto` / `sf-flow-create-workflow`) extend pair and drive pi-dynamic-workflows internally.
- **Tier 2 — declarative YAML flows** (the 3-knob `agents`/`phases`/`loops` model) compiled by a generator into a pi-dw script and registered as `/<name>` commands.

## Authoring a reusable flow (3 knobs: agents, phases, loops)

```yaml
name: auth-audit
description: Audit auth coverage across route files
input: prompt
agents:
  scanner: { tools: [read, grep, find], model: haiku, thinking: low }
  auditor: { model: sonnet, thinking: high, isolated: true, schema: { verdict: "APPROVED|REVISE" } }
phases:
  - { id: scan, agent: scanner, prompt: "List every route file.", out: files }
  - { id: audit, agent: auditor, fanout: files, prompt: "Audit {{item}}.", out: findings }
loops:
  audit: { until_dry: true, max_rounds: 3 }
```

- **agents** — per-agent `tools`/`model`/`thinking`/`isolated`/`schema`.
- **phases** — each runs exactly one of `agent` / `skill` / `raw`; supports `prompt`, `fanout` (iterate a list), `verify`, `in`, `out`.
- **loops** — `until_dry` (discovery loop, requires `fanout`) or `until: approved` (gate loop, requires the agent to declare a verdict `schema`); `fail_on` controls which severities block.

Cross-field rules (enforced by `validateFlowYaml`): exactly one run-kind per phase; `fanout` only on agent phases and requires `out`; `until_dry` requires `fanout`; `until: approved` requires a verdict schema; no loops on skill/raw phases; unique `out` names.

Run with `sf_flow_auto auth-audit "<prompt>"` (input may be a prompt, `*.md`, `prd:<path>`, or `jira STORY-123`).

## Commands

| Command | Purpose |
|---|---|
| `sf_flow_plan` | Multi-milestone plan with parallel research + iterative review |
| `sf_flow_implement` | Execute a plan: 1 worktree, TDD per story, audit gate before commit |
| `sf_flow_audit` | CodeRabbit-style audit (7 angles + dual-blind AND-gate + fix-apply) |
| `sf_flow_auto <name> <input>` | Run a defined flow end-to-end, no human gates |
| `sf_flow_create_workflow` | Wizard: interview → YAML → `/<name>` |

## Code audit triad

`sf_flow_audit` runs four modules sharing a P0–P3 + verdict contract:

1. **codereview** — wraps pi-dw `/code-review`: 7 finder angles (A/B/C correctness medium-tier, D/E/F cleanup small-tier, G altitude big-tier), each finding verified (CONFIRMED/PLAUSIBLE/REFUTED — REFUTED dropped), deduped by file:line:summary, ranked correctness > cleanup > altitude. Diffs cap at `MAX_DIFF_CHARS` (200000).
2. **auditcode** — 10-section self-checklist (`Supply Chain & Security`, `Provenance & Metadata`, `Law of Demeter`, …); `gateExitCode` returns 1 on any failure; `qualityScore = 100*(total-must-should)/total`.
3. **requestreview** — Santa-method dual-blind AND-gate: two independent reviewers must both pass (`mustFix==0 && score>=threshold`, default 0.94); bounded by `MAX_REVIEW_ITERATIONS` (5).
4. **respondreview** — `categorize` (P0/P1 must-fix, P2 should-fix, P3 consider) + `applyOrder` (severity rank).

Output is rendered via `renderReport` in pair's `### P0…P3` + `## Verdict` format; `VERDICT: APPROVED` only when no P0/P1/P2 remain.

## tmux visualization

Per-agent panes driven by pi-dw's event stream: `subagents:created` opens a pane; `subagents:completed`/`subagents:failed` close it. Two themes (`codex` with ANSI status colors, `plain` with no escape codes). Escape hatches: `SF_FLOW_NO_TMUX=1` or `tmux.enabled=false` — when disabled the renderer is a byte-identical no-op (`NOOP_WHEN_DISABLED`). Session names follow `sf-flow-<hex>`; adoption is name-guarded.

## Config

Layered global + project JSON (`~/.pi/sf/flow/config.json`, `<repo>/.pi/sf/flow/config.json`); partial configs are merged over defaults. Reviewer/explorer models resolve via a 4-step chain: prompt → config → env (`SF_FLOW_REVIEWER_MODEL` / `SF_FLOW_EXPLORER_MODEL`) → ask/inherit.

```json
{
  "reviewer": { "model": "anthropic/sonnet-4-6" },
  "audit": { "threshold": 0.94, "max_rounds": 5 },
  "tmux": { "enabled": true, "theme": "codex" },
  "worktree": { "branch_prefix": "flow/" }
}
```

## Migration from team

`flow` replaces `team`'s tmux visualization + dynamic dispatch + audit on the pi-subagents / pi-dynamic-workflows foundation, **without** subprocess orchestration or milestone/story parallel lanes (deliberately dropped). Map: `team` plan/implement → `sf_flow_plan` / `sf_flow_implement`; `team`'s audit → `sf_flow_audit`; user-defined team workflows → Tier 2 YAML flows via `sf_flow_create_workflow` + `sf_flow_auto`. `flow` is self-contained (no `@pi-stef/team` or `@pi-stef/agent-workflows` import), so deprecating `team` later cannot break it.
