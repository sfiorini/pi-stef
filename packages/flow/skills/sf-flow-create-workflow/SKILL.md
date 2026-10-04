---
name: sf-flow-create-workflow
description: Adaptive wizard that consults local bundled examples, suggests building blocks by task archetype, validates sections incrementally or full cross-field, writes YAML + agent stubs, and registers the flow.
---

# sf-flow-create-workflow

## Purpose

Turn a user's intent into a validated `.pi/sf/flow/workflows/<name>.yaml` and register it as `/<name>`. The **tool** now handles validation, writing, and registration; the **agent's** job is the interview — guiding the user through adaptive suggestions derived from local bundled examples.

**Core principle: agents are DEFINED in their `.md` files** (project `.pi/agents/<name>.md` overrides global `getAgentDir()/agents/<name>.md`, default `~/.pi/agent/agents/`). A workflow only NAMES the agents its phases use — it never defines an agent or its model/tools/thinking/isolation. The agent stubs you emit in Phase 2.5 carry those properties; the user edits them freely.

## Tool parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | kebab-case flow name |
| `description` | No | One-liner describing the flow |
| `input` | No | `prompt` / `md-file` / `prd` / `jira` |
| `agents_yaml` | No | Pre-formed agents YAML — a LIST of names (e.g. `- scanner\n- auditor`) |
| `phases_yaml` | No | Pre-formed phases YAML section |
| `loops_yaml` | No | Pre-formed loops YAML section |
| `groups_yaml` | No | Pre-formed groups YAML section |
| `overwrite` | No | `true` to replace an existing workflow of the same name |

**Path selection** (determined by which params are present):

- **Path A — assemble → validate → write → register:** `name` + `description` + `input` + `agents_yaml` + `phases_yaml` (and optionally `loops_yaml`, `groups_yaml`). Tool runs full cross-field validation, writes the YAML, and registers `/<name>`.
- **Path B — validate sections only:** some `*_yaml` params present but not enough for Path A. Tool validates each supplied section and reports what's missing.
- **Path C — wizard:** no params at all. Tool enters interactive wizard mode.

If the target file already exists, the tool returns `collision`; pass `overwrite: true` to replace it.

## Phase 0: Consult LOCAL bundled context

**Before asking the user anything**, read these local files (bundled in the repo, NOT URLs) to internalize the canonical patterns:

1. `packages/flow/templates/workflow.yaml` — the skeleton template
2. `packages/flow/workflows/ship-feature.yaml` — full-lifecycle, multi-group
3. `packages/flow/workflows/code-review.yaml` — audit-then-fix with groups + `until:approved`
4. `packages/flow/workflows/auth-audit.yaml` — batch-scan/discovery with fanout + `until_dry`
5. `packages/flow/workflows/research-report.yaml` — parallel-research + synthesis with fanout
6. `packages/flow/workflows/deep-research.yaml` — complex inline with raw phases + `agent()`

These are your building-block library. Refer to them when suggesting structures in Phase 1.

## Phase 1: Intake + adaptive suggestions

### 1a. Free-form description

Ask: *"What should this flow do?"* — let the user describe their intent in their own words.

### 1b. Task-archetype table

Match the user's intent to the closest archetype and suggest building blocks:

| Intent / Archetype | Closest example | Key building blocks |
|---------------------|-----------------|---------------------|
| Audit-then-fix (review, find issues, fix, iterate) | `code-review` | `groups` + `until:approved` + gate verdict `schema` on the gate PHASE |
| Batch scan / discovery (scan many files, aggregate) | `auth-audit` | `fanout` + `until_dry` + fanout `out` |
| Ambiguous requirements (need to clarify before building) | `ship-feature` | `questions` phase as first phase |
| Full lifecycle (plan → implement → review → ship) | `ship-feature` | multi-group, `questions` + `groups` + loops |
| Parallel research + synthesis (multiple researchers, merge) | `research-report` | `fanout` on research phases + synthesis `agent` phase |
| Complex inline reasoning (deep multi-step analysis) | `deep-research` | `raw` phase with `agent()` expression |

Present the suggested archetype and explain which building blocks apply. Let the user confirm or adjust.

### 1c. Phase kinds reminder

Each phase runs **exactly one** of:
- `agent` — a named agent (defined in its `.md`; the phase may carry a `schema` contract)
- `skill` — a registered skill by name
- `raw` — a raw phase expression (e.g. `agent()` inline)
- `questions` — an interview loop with a named agent

### 1d. Targeted questions

Ask **one at a time** (not all at once):

1. **Name** — kebab-case (e.g. `security-audit`)
2. **Description** — one-liner
3. **Input** — `prompt` / `md-file` / `prd` / `jira`
4. **Agents** — just the NAMES this flow uses (existing `.md`-defined agents like `reviewer`/`auditor`/`developer`/`researcher`/`synth`/`scanner`/`elicitor`/`notifier`, or new ones you'll stub in Phase 2.5). For each NEW agent: what it does (drives the stub's role, `tools`, and `thinking`), and which phases need a structured-output `schema` (e.g. a gate phase's `verdict`)
5. **Phases** — for each phase: id, run type (`agent`/`skill`/`raw`/`questions`), prompt, any `fanout`/`verify`/`in`/`out`, and its `schema` when the result is gated or consumed (gates: `{ verdict: APPROVED|REVISE, findings: array }`; elicitors: `{ questions: array }`). For `questions` phases: the agent name (must be named in `agents`) and optional `max_rounds` (default 5)
6. **Loops** — for any phase or group: `until_dry` or `until:approved` (+ `fail_on` + `max_rounds`). Loop keys resolve group-first
7. **Groups** — optional: for each group, the gate phase id (first) + fix phase ids (rest, ≥2 total); all must be agent phases; the group name must have a matching `loops` entry

## Phase 2: Assemble + invoke the tool

Assemble the collected parameters — `agents_yaml` as a YAML list of names — and call `sf_flow_create_workflow`. Handle the result:

| Result | Meaning | Action |
|--------|---------|--------|
| `done` | Success | Proceed to Phase 2.5 |
| `validation-error` | Cross-field validation failed | Surface errors, fix the broken fields, re-invoke |
| `collision` | Workflow file already exists | Ask user: overwrite? If yes, re-invoke with `overwrite: true` |
| `parse-error` | YAML syntax error | Fix the YAML syntax, re-invoke |
| `partial-valid` | Some sections valid, some missing | Fill in the missing sections, re-invoke |
| `wizard` | Called with no params | Start the interview from Phase 1 |

## Phase 2.5: Emit write-once agent stubs

For each agent NAMED in the flow **without** an existing `.md` file (check the project `<cwd>/.pi/agents/<name>.md` first — it overrides — then the global `getAgentDir()/agents/<name>.md`, default `~/.pi/agent/agents/`), write the stub to the **project** dir `<cwd>/.pi/agents/<name>.md` (project definitions are the natural home for a flow-specific agent; the user can move it to the global dir later to share it):

- **Frontmatter:** `description` (the role), `tools`, `thinking`, `isolated` per the interview, plus a commented model hint naming the tier the agent needs (from the interview: opus-class for reasoning-heavy roles, sonnet-class for review/scout roles, haiku-class for super-light roles) with example IDs. Tell the user to uncomment `model:` and set their preferred one (full `provider/modelId`) — with no `model:` the agent inherits the orchestrator.
- **Body:** the agent's system prompt, derived from the interview (what it does) + the phase prompts that reference it.

**Never overwrite** an existing agent file. This is write-once — the user edits these freely. The workflow references the agent by NAME only; all definition lives in the `.md`.

## Phase 5: Confirm

Tell the user:

> Flow **"<name>"** created at `.pi/sf/flow/workflows/<name>.yaml`. Run it with:
> `sf_flow_auto <name> "<prompt>"` (or a file path, PRD, or Jira id).

## Cross-field rules

Enforced by `validateFlowYaml` in the tool. These are documented here so the agent can explain them to the user:

- Each phase must set **exactly one** of `agent` / `skill` / `raw` / `questions`
- `agents` is a **list of names** — declare each agent once; every phase `agent`/`questions` must be in it
- `questions` and `fanout`/`verify` are **mutually exclusive**
- `fanout` is only supported on `agent` phases and requires the phase to declare `out`
- `until_dry` requires the phase to set `fanout`
- `until: approved` requires the GATE PHASE to declare a `schema.verdict` (and `schema.findings` for `protocol: canonical-delta`) — the schema is a phase property, not an agent's
- Loops are **not** supported on `skill` / `raw` / `questions` phases (questions has a built-in follow-up loop)
- `out` values must be **unique** across phases
- `groups.<name>.phases` must be ≥2, all agent phases; a phase may belong to at most one group
- Every `groups.<name>` must have a matching `loops.<name>`
- Loop keys that match a group name resolve as **group loops** (group-first precedence over phase loops)
