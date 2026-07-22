# @pi-stef/flow

> Reusable multi-agent workflows and CodeRabbit-style code audit for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — **making workflows simple.**

Built on [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) + [`@quintinshaw/pi-dynamic-workflows`](https://github.com/quintinshaw/pi-dynamic-workflows).

```bash
pi install npm:@pi-stef/flow
```

Flow lets you describe a multi-agent workflow in ~15 lines of YAML (three knobs: **agents**, **phases**, **loops**) and run it end-to-end with no human gates. It also ships battle-tested plan/implement/audit skills. It unifies `pair`'s simplicity with pi-dynamic-workflows' orchestration and a CodeRabbit-style audit rigor; It supersedes the now-deprecated @pi-stef/team and @pi-stef/pair (see https://sfiorini.github.io/pi-stef/migrating-from-team-and-pair).

Full docs: <https://sfiorini.github.io/pi-stef/packages/flow>

---

## The mental model (read this first)

Flow has **three layers**, kept deliberately separate. Confusing them is the #1 source of confusion:

| Layer | What it is | Where it lives | Who writes it |
|-------|------------|----------------|---------------|
| **Agent** | A role's *behavior* — a system prompt + frontmatter (`tools`, `thinking`, …). **Never carries a `model:`** — the model is supplied at dispatch. | `~/.pi/agent/agents/<name>.md` (global) or `.pi/agents/<name>.md` (project overrides global) | flow ships **8 defaults**; you edit/add freely (write-once) |
| **Workflow** | *What runs, in what order* — either a built-in skill (Tier 1) or a YAML file (Tier 2). | Tier 1: built-in skills · Tier 2: `~/.pi/sf/flow/workflows/<name>.yaml` (global defaults) or `.pi/sf/flow/workflows/<name>.yaml` (project override) | flow ships skills + **4 example YAMLs** (`/sf-flow-seed`); you add YAMLs |
| **Config** | *Runtime settings* — which model each agent runs on, audit thresholds, worktree. | `~/.pi/sf/flow/config.json` (global) + `.pi/sf/flow/config.json` (project) | you (partial is fine) |

> ### ⚠️ Config does NOT define agents or workflows
> Agents (reviewer, explorer, developer, planner, auditor, synth) are **defined as `.md` files** (`~/.pi/agent/agents/<name>.md`) and **used by** the plan/implement/audit skills. `config.json` only sets **which model** each agent runs on (plus `audit` / `worktree` settings). An agent's *behavior* lives in the `.md` file — config never describes how an agent thinks.
>
> So `{"reviewer":{"model":"anthropic/sonnet-4-6"}}` means *"run the reviewer agent (already defined) on Sonnet 4.6"* — it does **not** create the reviewer. The seven model groups (`reviewer`/`explorer`/`developer`/`planner`/`auditor`/`synth`/`designer`) are all optional; an unset model inherits the orchestrator (uniform fallback, no fail-fast).

**Where the model comes from, per tier:**

- **Tier 1 skills** (`sf_flow_plan` / `sf_flow_implement` / `sf_flow_audit`) — models **self-resolved** by the skill from `config.json` (project then global → env → inherit orchestrator). The tool pre-resolves + echoes them (visibility only); the skill is the resolver, so a workflow delegating via a `skill:` phase honors config too.
- **Tier 2 YAML flows** — each agent sets `model:` **inline in the YAML** (fuzzy alias like `sonnet`), independent of `config.json` (falls back to the `.md` `model:`, else the orchestrator).

---

## Quickstart

```bash
# 1. Audit your current diff — zero config, runs the 7-angle triad + dual-blind gate
/sf-flow-audit

# 2. Plan, then implement a feature (reviewer model from config.json)
/sf-flow-plan add OAuth login
/sf-flow-implement 2026-07-20-oauth-login

# 3. Run a reusable flow end-to-end (seed the 4 examples to ~/.pi/sf/flow/workflows via /sf-flow-seed)
sf_flow_auto code-review "review the auth changes"
```

Or in natural language:

```
"Plan a feature for adding user authentication, use anthropic/sonnet-4-6 as reviewer"
"Implement the plan in ai_plan/2026-07-20-oauth-login"
"Run the code-review flow on the staged diff"
```

---

## Built-in agents

Nine write-once agent definitions ship in `packages/flow/agents/` and are copied to your **global** discovery dir (`~/.pi/agent/agents/`) by `/sf-flow-seed` (or lazily on first use of a Tier 1 skill):

| Agent | Role | `tools` | `thinking` |
|-------|------|---------|-----------|
| `planner` | Workflow Planner — milestones + stories | read, grep, find, ls | medium |
| `designer` | Workflow Designer — design via brainstorming (2–3 approaches → recommend 1) | read, grep, find, ls | high |
| `explorer` | Codebase Explorer — read-only research | read, grep, find, ls | low |
| `developer` | TDD Developer — red/green/refactor | read, grep, find, ls, write, bash | medium |
| `reviewer` | Plan/Implementation Reviewer | read, grep, find, ls | high |
| `auditor` | Code Auditor (CodeRabbit-style) | read, grep, find, ls | high |
| `synth` | Synthesis / Report Writer | read, write | medium |
| `scanner` | Route/File Scanner — enumerate files for fan-out | read, grep, find, ls | low |
| `researcher` | Researcher — cited claims per angle | read, grep, find, ls | medium |

- **Write-once:** flow *never* overwrites an existing agent file — edit any of them freely.
- **No `model:` in the file:** the model is resolved at dispatch time.
- **Project overrides global:** `<repo>/.pi/agents/reviewer.md` shadows the global one.
- **Seven are config-backed; two are example-workflow agents.** `reviewer`/`explorer`/`developer`/`planner`/`auditor`/`synth`/`designer` have optional `config.json` model groups. `scanner` and `researcher` power the `auth-audit` and `research-report` example flows — they are Tier-2 agents whose model is set **inline in their workflow YAML**, not in `config.json`.

**Add a new agent:** drop a `<name>.md` at `~/.pi/agent/agents/` (global) or `.pi/agents/` (project), then reference it by name in a workflow's `agents:` block. `sf_flow_create_workflow` also writes a write-once stub for any declared agent that doesn't yet exist.

---

## Built-in workflows (examples)

Four reference flows ship in `packages/flow/workflows/`. They are **global** defaults — copy them once with `/sf-flow-seed` (or they seed lazily on first use) into `~/.pi/sf/flow/workflows/`, where they're available in **every** project:

| Workflow | File | What it does |
|----------|------|--------------|
| `code-review` | `code-review.yaml` | CodeRabbit-style review of a diff (audit triad) |
| `ship-feature` | `ship-feature.yaml` | Plan → implement → audit a feature, gated until `APPROVED` |
| `auth-audit` | `auth-audit.yaml` | Scan route files, fan out audits, dedup, synthesize a report |
| `research-report` | `research-report.yaml` | Multi-perspective research with cross-checking + synthesis |

- **Global defaults** live at `~/.pi/sf/flow/workflows/`; a **project override** at `<repo>/.pi/sf/flow/workflows/<name>.yaml` shadows the global one (resolved project→global by `sf_flow_auto`).
- **`/<name>` commands** (`/code-review`, …) register at pi startup from the global + current-project workflow dirs.
- **Re-seed safely:** `/sf-flow-seed` never clobbers your edits — if a file differs from the bundled default, the new default is written as `<name>.new` beside it.

```bash
# Seed the defaults globally, then run one from any project:
/sf-flow-seed
sf_flow_auto ship-feature "add a rate limiter to the API"
```

---

## Tier 1 — the built-in skills

| Skill | Slash | Tool | Purpose |
|-------|-------|------|---------|
| Plan | `/sf-flow-plan` | `sf_flow_plan` | Multi-milestone plan with **parallel** research + iterative review |
| Implement | `/sf-flow-implement` | `sf_flow_implement` | One worktree, TDD per story, **audit gate** before commit |
| Audit | `/sf-flow-audit` | `sf_flow_audit` | CodeRabbit-style audit (7 angles + dual-blind AND-gate + fix-apply) |
| Auto | `/sf-flow-auto` | `sf_flow_auto` | Run any defined flow end-to-end, no human gates |
| Create Workflow | `/sf-flow-create-workflow` | `sf_flow_create_workflow` | Wizard: interview → YAML → `/<name>` |
| Seed | `/sf-flow-seed` | `sf_flow_seed` | Copy default agents + example workflows to their global locations |
| — | — | `sf_flow_finalize` | Remove a flow worktree dir, preserve its branch |

### sf_flow_plan

Multi-milestone plan with parallel research and iterative reviewer approval. Produces `ai_plan/<slug>/`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | No | The task to plan |
| `reviewer_model` | No | Override reviewer model (else self-resolved from [config](#configuration)) |
| `explorer_model` | No | Override explorer model (inherits parent if unset) |

Phases: fan out N explorers in parallel → codebase map → gather requirements one question at a time → design (brainstorming) → plan (writing-plans: milestones + `S-MN{seq}` stories) → iterative reviewer loop (fix P0/P1/P2, max 10 rounds) → write plan files → optional Telegram notify.

### sf_flow_implement

Execute an approved plan in **one** worktree (`flow/<slug>`, git-only), TDD per story, audit triad as a **non-optional gate** before commit.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Plan folder slug or path under `ai_plan/` |
| `reviewer_model` | No | Override reviewer model |

Per-milestone: TDD each story → reviewer loop → commit to worktree branch → update tracker. After all milestones: run `sf_flow_audit` on the accumulated diff; on `REVISE` loop back to the failing **story** (bounded by `audit.max_rounds`, default 5). Finish with `sf_flow_finalize`.

### sf_flow_audit

CodeRabbit-style audit returning P0–P3 + verdict (`APPROVED` / `REVISE`). See the [audit triad](#code-audit-triad).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `target` | No | Diff target: git ref range, file path, or `workdir`. Defaults to `git diff HEAD` |
| `reviewer_model` | No | Override reviewer model |
| `apply_fixes` | No | If true, run respond-review to apply must-fix / should-fix |

### sf_flow_auto

Run a defined flow end-to-end with **no human gates**.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workflow` | Yes | Flow name (resolved project→global: `.pi/sf/flow/workflows/<name>.yaml` overrides `~/.pi/sf/flow/workflows/<name>.yaml`) |
| `input` | Yes | `prompt` · path to a markdown file · `prd:<path>` · `jira STORY-123` |

### sf_flow_create_workflow

Turn intent into a validated flow. Interviews one question at a time, writes `.pi/sf/flow/workflows/<name>.yaml` (project-scoped), emits write-once agent stubs, validates, and registers `/<name>`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | kebab-case flow name |
| `description` | No | One-liner |
| `input` | No | `prompt` / `md-file` / `prd` / `jira` |
| `agents_yaml` | No | Pre-formed agents YAML to skip the interview |
| `phases_yaml` | No | Pre-formed phases YAML |
| `loops_yaml` | No | Pre-formed loops YAML |

### sf_flow_finalize

Remove a flow worktree directory while **preserving** its branch.

| Parameter | Type | Description |
|-----------|------|-------------|
| `worktree_path` | string | Absolute path of the flow worktree to remove |

---

## Tier 2 — declarative YAML flows (the 3-knob model)

Describe a workflow with three knobs; the generator compiles it into a pi-dynamic-workflows script.

```yaml
# .pi/sf/flow/workflows/auth-audit.yaml
name: auth-audit
description: Audit auth coverage across route files
input: prompt
agents:
  scanner: { tools: [read, grep, find], model: haiku, thinking: low }
  auditor: { tools: [read, grep, find], model: sonnet, thinking: high, isolated: true,
             schema: { verdict: "APPROVED|REVISE" } }
  synth:   { tools: [read, write], model: sonnet }
phases:
  - { id: scan,   agent: scanner,  prompt: "List every route file under src/routes/.", out: files }
  - { id: audit,  agent: auditor,  fanout: files, prompt: "Audit {{item}} for missing auth checks.", out: findings }
  - { id: verify, agent: auditor,  verify: findings, threshold: 0.66, out: confirmed }
  - { id: report, agent: synth,    in: confirmed, prompt: "Write a cited report from these findings." }
loops:
  audit: { until_dry: true, max_rounds: 3, dedup_key: "{{file}}:{{line}}:{{summary}}" }
```

Run it: `sf_flow_auto auth-audit "check the API routes"`.

### Knob 1 — `agents`

A map of agent-name → definition. The agent's *behavior* comes from its `.md` file; the YAML only adds runtime config:

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `string[]` | Tools the agent may use |
| `model` | `string` | Fuzzy model alias (`haiku`, `sonnet`, …). **Independent of `config.json`** |
| `thinking` | `enum` | `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` |
| `isolated` | `boolean` | Spawn in a fresh context |
| `schema` | `object` | Structured output contract (required for `until: approved`) |

### Knob 2 — `phases`

An ordered list. **Each phase runs exactly one of** `agent` / `skill` / `raw`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Phase identifier (referenced by `loops`) |
| `agent` | `string` | Run an agent (must be declared in `agents`) |
| `skill` | `string` | Run a built-in skill (e.g. `sf-flow-audit`) — opaque |
| `raw` | `string` | Run a raw pi-dw snippet — opaque |
| `prompt` | `string` | Prompt template; `{{item}}` / `{{<out>}}` interpolated |
| `fanout` | `string` | Iterate a list — a prior `out` or `args.*` (agent phases only) |
| `verify` | `string` | Cross-check a prior `out`; pass when `>= threshold` survive |
| `threshold` | `number` | Verify pass ratio |
| `in` | `string \| string[]` | Feed prior `out`(s) in |
| `out` | `string` | Name this phase's output |

### Knob 3 — `loops`

A map of phase-id → loop. Two kinds:

| Field | Kind | Description |
|-------|------|-------------|
| `until_dry` | discovery | Run until nothing new is found. **Requires `fanout`.** Optional `dedup_key`, `consecutive_empty` |
| `until` | gate | `until: approved` — run until `schema.verdict` is `APPROVED`. **Requires a verdict `schema`** |
| `fail_on` | gate | Severities that block, e.g. `[P0, P1, P2]` |
| `max_rounds` | both | Bound on iterations |

### Validation rules

`validateFlowYaml` enforces these so a loop/fanout is never silently swallowed (invalid flows fail at registration):

1. Each phase sets **exactly one** of `agent` / `skill` / `raw`.
2. `agent` must reference a name declared in `agents`.
3. `fanout` is allowed **only** on agent phases.
4. `fanout` **requires** `out`.
5. `verify` must reference a **prior** `out`.
6. `out` names must be **unique**.
7. `loops.<phaseId>` must reference an existing phase.
8. Loops **not** allowed on `skill` phases.
9. Loops **not** allowed on `raw` phases.
10. `until_dry` **requires** `fanout`.
11. `until: approved` **requires** a `schema.verdict`.

### Defining a new flow

- **Wizard** — `/sf-flow-create-workflow` (writes YAML + agent stubs, validates, registers `/<name>`).
- **By hand** — create `.pi/sf/flow/workflows/<name>.yaml` (project) or `~/.pi/sf/flow/workflows/<name>.yaml` (global), then `sf_flow_auto <name> <input>` (validates + generates eagerly).

---

## Code audit triad

`sf_flow_audit` runs four modules sharing a P0–P3 + verdict contract. `VERDICT: APPROVED` only when no P0/P1/P2 remain.

| Module | What it does |
|--------|--------------|
| **codereview** | pi-dw `/code-review`: **7 finder angles** (A/B/C correctness, D/E/F cleanup, G altitude). Each verified 3-way (CONFIRMED/PLAUSIBLE/REFUTED — REFUTED dropped), deduped by `file:line:summary`, ranked correctness > cleanup > altitude. Cap `MAX_DIFF_CHARS` (200000). |
| **auditcode** | **10-section** self-checklist (Supply Chain & Security, Provenance & Metadata, Law of Demeter, …). `--gate` exits 1 on any failure; `qualityScore = 100*(total − must − should)/total`. |
| **requestreview** | **Dual-blind AND-gate**: two independent reviewers must **both** pass (`mustFix == 0 && score >= threshold`). Bounded by `MAX_REVIEW_ITERATIONS` (5). |
| **respondreview** | `categorize` (must/should/consider) + `applyOrder` (severity). If `apply_fixes`, applies in order then re-runs test/typecheck/lint. Every finding addressed. |

### `/sf-flow-audit` vs the `code-review` flow

Both run the same audit triad, so they look interchangeable — but the wrapper matters:

| | `/sf-flow-audit` | `sf_flow_auto code-review` |
|---|---|---|
| Tier | 1 (built-in skill) | 2 (YAML flow) |
| What runs | the skill inline, in your current session | a generated pi-dw script that spawns a `general-purpose` agent to run the skill |
| Model source | config (`reviewer.model`) | config (`reviewer.model`) — *via the skill* |
| Result | findings + verdict into your chat | a flow result — the skill phase's `out` is **opaque** (a placeholder string) |
| Gated loop | no (one-shot; `apply_fixes` applies once) | **not on a skill phase** (skill phases can't loop) |
| Extensible | fixed skill steps | edit the YAML: add phases, chain it, version & share it |
| Input | `target` (git ref / file / `workdir`) | `prompt` · `md-file` · `prd` · `jira` |

Today `code-review.yaml` is a pure skill wrapper (no agent phases of its own), so functionally it's nearly identical to the skill — including the model source: both resolve the reviewer from config. **Use the skill** for a quick, zero-overhead audit in your current task. **Use the flow** when you want a reusable, shareable, composable artifact — e.g. chain it after plan + implement (that's `ship-feature.yaml`). Remember: a flow's **agent** phases get their model from the YAML (`agents.<name>.model`); its **skill** phases inherit the skill's config-driven model.

> **Need a gated audit loop in a flow?** A skill phase can't loop (rule #8). Use an **agent** phase with `until: approved` instead — see the `audit` phase in `ship-feature.yaml`, which gates an auditor until `verdict: APPROVED`.

---

## Agent resolution

When a skill or phase needs to spawn an agent, the type is resolved deterministically:

1. If an agent definition `<name>.md` exists → spawn that named agent (`name`).
2. Else `planner` → built-in `Plan`; `reviewer` → built-in `Reviewer`.
3. Anything else with no `.md` → `general-purpose`.

A missing `explorer.md` does **not** fall back to the built-in `Explore` (which forces Haiku) — it yields `general-purpose`, inheriting the orchestrator model. This rule is encoded in code (`resolveAgentType`) + stated verbatim in every tier-1 skill, so the direct (tool) path and the workflow (`skill:` phase) path spawn the same agent type.

The orchestrator is **orchestrator-only**: in `/sf-flow-implement` it writes no code — it delegates each milestone to the `developer` agent and runs the per-milestone reviewer gate.

## Plan standard (exhaustive milestone plans)

Plans are consumed by an implementer that may be a weaker model, so `/sf-flow-plan` enforces an **exhaustive** standard: every story must specify exact files + lines, a precise change (no vague verbs like "refactor"/"improve"), rationale, acceptance criteria, edge cases, test expectations, and dependencies — enough that a less-intelligent model can implement it with **zero remaining design decisions**. A completeness self-check runs before finalizing, and the reviewer gate REVISEs under-detailed stories independent of correctness. (This applies to both the plan tool and a workflow's plan phase — both execute the same skill.)

---

## Configuration

Layered: project `.pi/sf/flow/config.json` over global `~/.pi/sf/flow/config.json` over defaults. Partial configs are fine.

```json
{
  "reviewer": { "model": "anthropic/sonnet-4-6" },
  "explorer": { "model": "anthropic/haiku-4-5" },
  "developer": { "model": "anthropic/sonnet-4-6" },
  "planner": { "model": "anthropic/sonnet-4-6" },
  "auditor": { "model": "anthropic/sonnet-4-6" },
  "synth": { "model": "anthropic/haiku-4-5" },
  "audit": { "threshold": 0.94, "max_rounds": 5 },
  "worktree": { "branch_prefix": "flow/" }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `<role>.model` | `string` | — | Model for one of the seven agents: `reviewer`, `explorer`, `developer`, `planner`, `auditor`, `synth`, `designer`. All optional; unset ⇒ inherits the orchestrator (no fail-fast) |
| `audit.threshold` | `number` | `0.94` | Dual-blind AND-gate pass score |
| `audit.max_rounds` | `integer` | `5` | Max audit fix-loop iterations |
| `worktree.branch_prefix` | `string` | `flow/` | Branch prefix for implement worktrees |

**Environment variables:** `SF_FLOW_REVIEWER_MODEL`, `SF_FLOW_EXPLORER_MODEL`, `SF_FLOW_DEVELOPER_MODEL`, `SF_FLOW_PLANNER_MODEL`, `SF_FLOW_AUDITOR_MODEL`, `SF_FLOW_SYNTH_MODEL`, `SF_FLOW_DESIGNER_MODEL`.

### Model resolution chain (Tier 1 skills)

Tier-1 skills **self-resolve** each agent's model: 1. a model passed in the invocation context (tool echo / workflow hint) → 2. config (`<role>.model`, project then global) → 3. env (`SF_FLOW_<ROLE>_MODEL`) → 4. **inherit the orchestrator model** (uniform fallback, no fail-fast). At dispatch, an unset model is *omitted* so pi-subagents applies the agent `.md` `model:` (if any) or inherits the orchestrator.

> Tier 2 YAML agents ignore this chain — they use the inline `model:` field (else the `.md`, else the orchestrator).

### Model precedence

A common question: *if an agent `.md` sets a `model:` and config sets a different one, which wins?* Config is a **6-agent model registry** (`reviewer`/`explorer`/`developer`/`planner`/`auditor`/`synth`); each group is `additionalProperties: false`.

| Agent used by | `.md` `model:` | YAML `model:` | config | → Model used |
|---|---|---|---|---|
| Tier 1 skill | (applied by pi-subagents only if config/env unset) | — | set | **config** |
| Tier 1 skill | (applied if unset) | — | unset | **`.md`** → else **orchestrator** (uniform fallback) |
| Tier 2 flow agent | set | set | (no effect) | **YAML** |
| Tier 2 flow agent | set | omitted | (no effect) | **`.md`** (fallback) |
| Tier 2 flow agent | omitted | omitted | (no effect) | orchestrator / session model |

**Why config wins for Tier 1 (when set):** the skill self-resolves + passes the model *explicitly* at dispatch — `Agent({ subagent_type: "reviewer", model: "<from config>" })` — overriding the `.md`. If config/env are both unset, the model is omitted so pi-subagents falls back to the `.md` `model:` (if any), else the orchestrator. The seven default agents ship with no `model:` — so an unset config simply inherits the orchestrator (no error).

**Why YAML wins for Tier 2:** the generator emits `model:` into the agent call only when the YAML declares it (`generate.ts`: `if (def.model) parts.push(...)`). Omit it and pi-subagents falls back to the `.md`'s `model:` (else the orchestrator). Config has no effect on Tier 2 agents.

---

## Architecture

- **Skill-driven design** — the tools are thin: each pre-resolves config + ensures agents exist, then hands off to a `SKILL.md` with the step sequence. The extension provides only config loading, model resolution, write-once agent templates, agent-type resolution, and worktree helpers.
- **Model resolution** — Tier-1 skills **self-resolve** models from `config.json` (project → global → env → inherit orchestrator); the tools pre-resolve + echo them for visibility. Agent types resolve by `.md` filename match (see [Agent resolution](#agent-resolution)).
- **Orchestrator-only implement** — `/sf-flow-implement` writes no code: it delegates each milestone to the `developer` agent (TDD), runs the per-milestone reviewer gate, then the audit gate.
- **Worktree lifecycle (implement)** — create one `flow/<slug>` worktree → per-milestone developer delegation + reviewer loop + commit → audit gate (loop back to the failing story on `REVISE`) → `sf_flow_finalize` preserves the branch.

---

## Plan-folder layout

```
ai_plan/YYYY-MM-DD-<slug>/
├── original-plan.md         # Raw approved plan
├── final-transcript.md      # Conversation log
├── milestone-plan.md        # Full specification
├── story-tracker.md         # Status tracking
└── continuation-runbook.md  # Resume context
```

`ai_plan/` is gitignored.

---

## Migration from team & differences from pair

**From `team`:** plan/implement → `sf_flow_plan` / `sf_flow_implement`; audit → `sf_flow_audit`; user workflows → Tier 2 YAML. Dropped: subprocess orchestration, parallel lanes. `flow` imports neither `@pi-stef/team` nor `@pi-stef/agent-workflows`, so the deprecation of team cannot break it.

**From `pair`:** flow adds a fleet of parallel explorers, an audit triad gate, Tier 2 custom workflows, and a standalone `sf_flow_audit` — on the pi-subagents + pi-dynamic-workflows foundation.

## License

MIT
