# @pi-stef/flow

> Reusable multi-agent workflows and CodeRabbit-style code audit for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — **making workflows simple.**

Built on [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) + [`@quintinshaw/pi-dynamic-workflows`](https://github.com/quintinshaw/pi-dynamic-workflows).

```bash
pi install npm:@pi-stef/flow
```

Flow lets you describe a multi-agent workflow in ~15 lines of YAML (four knobs: **agents**, **phases**, **loops**, **groups**) and run it end-to-end with no human gates. It also ships battle-tested plan/implement/audit skills. It unifies `pair`'s simplicity with pi-dynamic-workflows' orchestration and a CodeRabbit-style audit rigor; it supersedes earlier workflow packages (see the migration guide).

Full docs: <https://sfiorini.github.io/pi-stef/packages/flow>

---

## The mental model (read this first)

Flow has **three layers**, kept deliberately separate. Confusing them is the #1 source of confusion:

| Layer | What it is | Where it lives | Who writes it |
|-------|------------|----------------|---------------|
| **Agent** | A role's *behavior* — a system prompt + frontmatter (`tools`, `thinking`, …). **Never carries a `model:`** — the model is supplied at dispatch. | `~/.pi/agent/agents/<name>.md` (global) or `.pi/agents/<name>.md` (project overrides global) | flow ships **10 defaults**; you edit/add freely (write-once) |
| **Workflow** | *What runs, in what order* — either a built-in skill (Tier 1) or a YAML file (Tier 2). | Tier 1: built-in skills · Tier 2: `~/.pi/sf/flow/workflows/<name>.yaml` (global defaults) or `.pi/sf/flow/workflows/<name>.yaml` (project override) | flow ships skills + **5 example YAMLs** (`/sf-flow-seed`); you add YAMLs |
| **Config** | *Runtime settings* — which model each agent runs on, audit thresholds, worktree. | `~/.pi/sf/flow/config.json` (global) + `.pi/sf/flow/config.json` (project) | you (partial is fine) |

> ### ⚠️ Config does NOT define agents or workflows
> Agents (reviewer, researcher, developer, planner, auditor, synth, designer) are **defined as `.md` files** (`~/.pi/agent/agents/<name>.md`) and **used by** the plan/implement/audit skills. `config.json` only sets **which model** each agent runs on (plus `audit` / `worktree` settings). An agent's *behavior* lives in the `.md` file — config never describes how an agent thinks.
>
> So `{"reviewer":{"model":"anthropic/sonnet-4-6"}}` means *"run the reviewer agent (already defined) on Sonnet 4.6"* — it does **not** create the reviewer. The seven model groups (`reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer`) are all optional; an unset model inherits the orchestrator (uniform fallback, no fail-fast).

**Where the model comes from, per tier:**

- **Tier 1 skills** (`sf_flow_plan` / `sf_flow_implement` / `sf_flow_audit`) — models **self-resolved** by the skill from `config.json` (project then global → env → inherit orchestrator). The tool pre-resolves + echoes them (visibility only); the skill is the resolver, so a workflow delegating via a `skill:` phase honors config too.
- **Tier 2 YAML flows** — inline wins; with no inline model, an agent **whose name matches a config group** (`reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer`/`elicitor`/`notifier`/`scanner`) falls back to `config.json`'s `<name>.model`, else `.md`, else orchestrator.

---

## Quickstart

```bash
# 1. Audit your current diff — zero config, runs the 7-angle triad + dual-blind gate
/sf-flow-audit

# 2. Plan, then implement a feature (reviewer model from config.json)
/sf-flow-plan add OAuth login
/sf-flow-implement 2026-07-20-oauth-login

# 3. Run a reusable flow end-to-end (seed the 5 examples to ~/.pi/sf/flow/workflows via /sf-flow-seed)
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

Ten write-once agent definitions ship in `packages/flow/agents/` and are copied to your **global** discovery dir (`~/.pi/agent/agents/`) by `/sf-flow-seed` (or lazily on first use of a Tier 1 skill):

| Agent | Role | `tools` | `thinking` |
|-------|------|---------|-----------|
| `planner` | Workflow Planner — milestones + stories | read, grep, find, ls | medium |
| `designer` | Workflow Designer — design via brainstorming (2–3 approaches → recommend 1) | read, grep, find, ls | high |
| `developer` | TDD Developer — red/green/refactor | read, grep, find, ls, write, bash | medium |
| `reviewer` | Plan/Implementation Reviewer | read, grep, find, ls | high |
| `auditor` | Code Auditor (CodeRabbit-style) | read, grep, find, ls | high |
| `synth` | Synthesis / Report Writer | read, write | medium |
| `scanner` | Route/File Scanner — enumerate files for fan-out | read, grep, find, ls | low |
| `elicitor` | Requirements Elicitor — clarifying questions | read, grep, find, ls | high |
| `researcher` | Researcher — codebase + web + private-source research, cited claims | read, grep, find, ls, bash, `ext:web/*` + `ext:atlassian/*` | medium |
| `notifier` | Notifier — Telegram completion summary (opt-in, Tier-2) | bash | low |

- **Write-once:** flow *never* overwrites an existing agent file — edit any of them freely.
- **No `model:` in the file:** the model is resolved at dispatch time.
- **Project overrides global:** `<repo>/.pi/agents/reviewer.md` shadows the global one.
- **Ten agents have config model groups (7 tier-1 + elicitor/notifier/scanner tier-2); inline YAML wins; bundled workflows are now configurable via config.json.** `reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer` have optional `config.json` model groups. `researcher` is dual-purpose: it is the 7th config group AND powers the `research-report` and `deep-research` example flows (the flow's inline `model: sonnet` overrides config for that flow). It is the **only** agent with `isolated: false` and `extensions: [web, atlassian]` (declared in its `.md` frontmatter) — see [Agent Isolation & Auth](https://sfiorini.github.io/pi-stef/guides/agent-isolation-and-auth). `scanner`, `elicitor`, and `notifier` are config-backed Tier-2 agents whose model resolves **inline YAML → config `<name>.model` → .md → orchestrator** (inline wins) — like all Tier-2 agents with a matching config group. `notifier` is an opt-in agent that sends a one-line completion summary via the bundled `notify-telegram.sh` when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (returns `skipped` silently otherwise) — declare it in a workflow's `agents:` block and run it from a final `notify` phase.

**Add a new agent:** drop a `<name>.md` at `~/.pi/agent/agents/` (global) or `.pi/agents/` (project), then reference it by name in a workflow's `agents:` block. `sf_flow_create_workflow` also writes a write-once stub for any declared agent that doesn't yet exist.

---

## Built-in workflows (examples)

Five reference flows ship in `packages/flow/workflows/`. They are **global** defaults — copy them once with `/sf-flow-seed` (or they seed lazily on first use) into `~/.pi/sf/flow/workflows/`, where they're available in **every** project:

| Workflow | File | What it does |
|----------|------|--------------|
| `code-review` | `code-review.yaml` | Audit↔fix loop (auditor gates, developer fixes, re-verify) |
| `ship-feature` | `ship-feature.yaml` | Clarify → design → plan → implement → audit, with find→fix→re-verify group loops |
| `auth-audit` | `auth-audit.yaml` | Scan route files, fan out audits, dedup, synthesize a report |
| `research-report` | `research-report.yaml` | Multi-perspective research with cross-checking + synthesis |
| `deep-research` | `deep-research.yaml` | Clarify scope via a research brief, then parallel code + web research with an analyst write-up |

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
| Create Workflow | `/sf-flow-create-workflow` | `sf_flow_create_workflow` | Adaptive wizard: suggests building blocks from local examples, validates, writes, registers `/<name>` |
| Seed | `/sf-flow-seed` | `sf_flow_seed` | Copy default agents + example workflows to their global locations |
| — | — | `sf_flow_finalize` | Remove a flow worktree dir, preserve its branch |

### sf_flow_plan

Multi-milestone plan with parallel research and iterative reviewer approval. Produces `ai_plan/<slug>/`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | No | The task to plan |
| `reviewer_model` | No | Override reviewer model (else self-resolved from [config](#configuration)) |
| `researcher_model` | No | Override researcher model (inherits parent if unset) |
| `designer_model` | No | Override designer model (inherits parent if unset) |

Phases: fan out N researchers in parallel → codebase map → gather requirements one question at a time → design (brainstorming) → plan (writing-plans: milestones + `S-MN{seq}` stories) → **delta-review** iterative reviewer loop (round 1 comprehensive, round 2+ verifies prior findings as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED; max 10 rounds) → write plan files → optional Telegram notify.

### sf_flow_implement

Execute an approved plan in **one** worktree (`flow/<slug>`, git-only), TDD per story, audit triad as a **non-optional gate** before commit.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Plan folder slug or path under `ai_plan/` |
| `reviewer_model` | No | Override reviewer model |

Per-milestone: TDD each story → **delta-review** reviewer loop (round 1 comprehensive, round 2+ verifies prior findings; max 5 rounds) → commit to worktree branch → update tracker. After all milestones: run `sf_flow_audit` on the accumulated diff; on `REVISE` loop back to the failing **story** (bounded by `audit.max_rounds`, default 5). Finish with `sf_flow_finalize`.

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

Adaptive wizard that consults local bundled example workflows to suggest building blocks by task archetype. Validates each section incrementally (partial) or full cross-field (complete). Writes YAML + agent stubs, registers `/<name>`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | kebab-case flow name |
| `description` | No | One-liner |
| `input` | No | `prompt` / `md-file` / `prd` / `jira` |
| `agents_yaml` | No | Pre-formed agents YAML to skip the interview |
| `phases_yaml` | No | Pre-formed phases YAML |
| `loops_yaml` | No | Pre-formed loops YAML |
| `groups_yaml` | No | Pre-formed groups YAML |
| `overwrite` | No | Replace an existing workflow of the same name |

### sf_flow_finalize

Remove a flow worktree directory while **preserving** its branch.

| Parameter | Type | Description |
|-----------|------|-------------|
| `worktree_path` | string | Absolute path of the flow worktree to remove |

---

## Tier 2 — declarative YAML flows (4 knobs + phase contracts)

Describe a workflow with four knobs (`agents` / `phases` / `loops` / `groups`) plus an
additive **phase-contract** layer (`inputs` / `outputs` / `worktree`); the generator
compiles it into a pi-dynamic-workflows script. Contracts make a tier-2 flow
**self-enforcing**: a phase that skips or fails its declared outputs starves the next
phase's required inputs → a concrete `blocked` state, never a silent skip.

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

An ordered list. **Each phase runs exactly one of** `agent` / `skill` / `raw` / `questions`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Phase identifier (referenced by `loops`) |
| `agent` | `string` | Run an agent (must be declared in `agents`) |
| `skill` | `string` | Run a built-in skill (e.g. `sf-flow-audit`) — opaque |
| `raw` | `string` | Run a raw pi-dw snippet — opaque |
| `questions` | `string` | Run an elicitor agent with a built-in clarifying-questions follow-up loop |
| `max_rounds` | `integer` | Max follow-up rounds for `questions` phases (default 5) |
| `prompt` | `string` | Prompt template; `{{item}}` / `{{<out>}}` interpolated |
| `fanout` | `string` | Iterate a list — a prior `out` or `args.*` (agent phases only) |
| `verify` | `string` | Cross-check a prior `out`; pass when `>= threshold` survive |
| `threshold` | `number` | Verify pass ratio |
| `in` | `string \| string[]` | Feed prior `out`(s) in (shorthand for `inputs.require` + inject) |
| `out` | `string` | Name this phase's output |
| `inputs` | `object` | Contract inputs: `{ require: [name…], inject: ["… {{name}} …"] }` |
| `outputs` | `object` | Contract outputs (see below) |
| `worktree` | `enum` | `none` · `prepare` · `finalize` — engine-owned worktree lifecycle |

#### Phase contracts — `inputs` / `outputs` / `worktree` (the enforcement model)

A phase may declare a contract. The generator compiles it into named steps backed by
helper tools that the orchestrator calls verbatim — there is no hidden runtime, and the
orchestrator must follow the emitted steps exactly: `sf_flow_contract` (derive-slug /
materialize / assert), `sf_flow_checkpoint` (load-required / complete / load-all), and for
the worktree lifecycle `sf_flow_prepare` (prepare) / `sf_flow_finalize` (finalize);
canonical-delta loops additionally call `sf_flow_gate`.

```yaml
- id: plan
  agent: planner
  out: plan_doc
  inputs: { require: [design_doc], inject: ["Design: {{design_doc}}"] }
  outputs:
    slug: { from: input, prefix: date }        # derive ai_plan/<slug>
    dir: "ai_plan/{{slug}}"
    artifacts:                                   # materialize resume-safe skeletons
      - { file: milestone-plan.md, template: "@flow/plan/milestone-plan.md" }
    assert: [nonempty]                           # block on missing/empty
    publish: { slug: "{{slug}}", plan_dir: "{{dir}}", plan_doc: plan_doc }
```

| Field | Description |
|-------|-------------|
| `inputs.require` | Names that must be published by an earlier phase (or built-in `input`/`flow`); a missing one blocks the phase — **self-defeating dataflow**. Each is destructured into a JS const the prompt can reference. |
| `inputs.inject` | Lines appended to the prompt, with `{{name}}` resolved to the in-scope const (not a runtime placeholder). `in:` is shorthand for `require` + an inject of the same name. |
| `outputs.slug` | `{ from: input, prefix: date \| none }` — derive the run slug. |
| `outputs.dir` | The artifact dir, e.g. `ai_plan/{{slug}}`. |
| `outputs.artifacts` | `{ file, template? }` — `@flow/plan/…` templates resolve to `packages/flow/templates/`. Materialized **resume-safe** (a non-empty file is never clobbered). |
| `outputs.assert` | `nonempty` (every target `.md` exists + non-empty), `tracker_valid`, `tracker_updated` (the milestone tracker). A failure blocks the phase. |
| `outputs.publish` | Values this phase feeds later phases: `{{slug}}`, `{{dir}}`, a bare `out` name, or a literal. Validation guarantees every emitted ref is in-scope. |
| `worktree` | `prepare` creates the `flow/<slug>` branch in a `flow-<slug>` worktree dir and publishes `{worktreePath, branchName, baseSha}`; `finalize` recovers the handle (resume-safe) and removes the worktree dir, preserving the branch. |

**Enforcement invariant.** Every phase ends with one atomic `sf_flow_checkpoint({mode:"complete"})`
(publish + mark success + persist). The terminal result reads `load-all`: `{status, finalPhase,
artifacts, worktree, resumeState}`. `sf_flow_auto` derives `args.slug` once and pre-seeds
`ai_plan/<slug>/.flow-state.json`; resume re-enters at the first non-success phase (or group),
reloading its required inputs — the orchestrator follows the workflow to the letter.

### Knob 3 — `loops`

A map of phase-id → loop. Two kinds:

| Field | Kind | Description |
|-------|------|-------------|
| `until_dry` | discovery | Run until nothing new is found. **Requires `fanout`.** Optional `dedup_key`, `consecutive_empty` |
| `until` | gate | `until: approved` — run until `schema.verdict` is `APPROVED`. **Requires a verdict `schema`** |
| `fail_on` | gate | Severities that block, e.g. `[P0, P1, P2]` |
| `max_rounds` | both | Bound on iterations |
| `protocol` | gate | `raw` (default — fresh review each round) · `canonical-delta` (carry `[Fn]`-numbered findings across rounds and AND-gate via verification each round ≥2; group-only, requires the gate agent's `findings` schema + `until: approved`) |

### Knob — `groups` (optional)

A map of group-name → `{ phases: [gate, ...fixers] }`. A group is a named collection of phases where the **first** phase is the gate (must have a `verdict` schema) and the rest are fix phases (all must be `agent` phases). When a `loops` key matches a group name (instead of a phase id), the generator emits a find→fix→re-verify loop: the gate runs → if REVISE with blocking findings, the fix phases run with findings appended → gate re-verifies → until APPROVED or max_rounds.

| Field | Type | Description |
|-------|------|-------------|
| `phases` | `string[]` | ≥2 phase ids; all must be `agent` phases; first = gate, rest = fix |

Loop keys resolve **group-first**: if a `loops` key matches both a group name and a phase id, the group wins.

### Validation rules

`validateFlowYaml` enforces these cross-field rules so a loop/fanout is never silently swallowed (invalid flows fail at registration, not at runtime):

| # | Rule |
|---|------|
| 1 | Each phase sets **exactly one** of `agent` / `skill` / `raw` / `questions` |
| 2 | `agent` must reference a name declared in `agents` |
| 3 | `questions` must reference a name declared in `agents` |
| 4 | `questions` and `fanout` are mutually exclusive |
| 5 | `questions` and `verify` are mutually exclusive |
| 6 | `fanout` is allowed **only** on agent phases |
| 7 | `fanout` **requires** `out` |
| 8 | `verify` must reference a **prior** phase's `out` |
| 9 | `out` names must be **unique** across phases |
| 10 | Every phase in `groups.<name>.phases` must exist and be an agent phase |
| 11 | A phase may belong to **at most one** group |
| 12 | Every `groups.<name>` must have a matching `loops.<name>` |
| 13 | `loops.<key>` that matches a group: `until_dry` is not allowed (use `until: approved`) |
| 14 | `loops.<key>` that matches a group with `until: approved`: the gate phase's agent must declare a `schema.verdict` |
| 15 | `loops.<key>` that matches a phase: must reference an existing phase |
| 16 | Loops are **not** allowed on `skill` phases |
| 17 | Loops are **not** allowed on `raw` phases |
| 18 | Loops are **not** allowed on `questions` phases (the follow-up loop is built-in) |
| 19 | `until_dry` **requires** the phase to set `fanout` |
| 19a | `until: approved` on a phase loop **requires** the phase agent to declare a `schema.verdict` |
| 20 | `inputs.require` names must resolve to a prior `out`/`publish` or a built-in (`input`/`flow`) — else unresolved |
| 21 | `worktree: finalize` requires a preceding `worktree: prepare` phase |
| 22 | artifact `template` refs must resolve (`@flow/…` or an existing path) |
| 23 | `publish` names must be valid identifiers; `{{slug}}`/`{{dir}}` require `outputs.slug`/`outputs.dir`; a bare value must be the phase `out` or a `require`d input (else it would emit an undefined ref) |
| 24 | `protocol: canonical-delta` requires a group loop, `until: approved`, and the gate agent's `findings` schema |

> **Caveat (rule 19a):** the guard checks `schema.verdict` presence only. An agent that declares a verdict schema but has no finding-capable tools (e.g. read-only with no analysis prompt) will always `APPROVE` — this is not structurally detectable.

> **Fail-closed gate (D4).** A gate result approves ONLY with a string `verdict === "APPROVED"` AND no blocking finding. `null`/`{}`/a `REVISE` with no findings/ an `APPROVED` with a blocking finding all reject — group and single-phase gates share one `_gateApproved` predicate.

### Defining a new flow

- **Wizard** — `/sf-flow-create-workflow` (adaptive: suggests building blocks from local examples, validates sections incrementally, writes YAML + agent stubs, registers `/<name>`).
- **By hand** — create `.pi/sf/flow/workflows/<name>.yaml` (project) or `~/.pi/sf/flow/workflows/<name>.yaml` (global), then `sf_flow_auto <name> <input>` (validates + generates eagerly).

### Notifications in custom workflows (Tier-2, opt-in)

Flow ships an opt-in **notifier** agent that sends a one-line completion summary to Telegram via the bundled `notify-telegram.sh` script. It is a normal Tier-2 agent — declare it and run it from a final phase in any custom workflow:

```yaml
agents:
  notifier:
    tools: [bash]
    thinking: low
    isolated: true
phases:
  - id: notify
    agent: notifier
    prompt: "ship-feature complete"
    out: notify_result
```

**Env-var contract** — the agent is a no-op (returns `skipped`) unless both are set:
- `TELEGRAM_BOT_TOKEN` — the Telegram bot token.
- `TELEGRAM_CHAT_ID` — the target chat id.
- `TELEGRAM_API_BASE_URL` *(optional)* — defaults to `https://api.telegram.org` (set it to a mock host for tests).

This is **Tier-2 only**: the Tier-1 skills (`sf_flow_plan` / `sf_flow_implement` / `sf_flow_audit`) each send their own completion notification (unchanged), but a YAML flow controls notification declaratively — add the phase, omit it, or repoint the prompt. The agent never blocks or retries; a `skipped` result is a normal outcome.

### Tier guarantees — what each phase kind gives you

| Phase kind | Runs via | Artifacts | Worktree | Audit gate | Resume |
|------------|----------|-----------|----------|------------|--------|
| `agent:` (with `outputs`) | dispatched agent | declared `artifacts` + `assert` | `prepare`/`finalize` | `until: approved` (raw or `canonical-delta`) | checkpointed (every phase `complete`s) |
| `agent:` (no contract) | dispatched agent | — | — | optional | checkpointed (marks success) |
| `skill:` (tier-1, e.g. sf-flow-plan) | **INLINE** — orchestrator runs the skill file | declared `artifacts` + `assert` (the skill writes the files) | — | — | checkpointed |
| `questions:` | elicitor + built-in follow-up | — | — | conditional (pauses for input) | checkpointed |
| `raw:` | opaque pi-dw snippet | self-managed | self-managed | self-managed | not checkpointed (opaque) |

---

## Code audit triad

`sf_flow_audit` runs four modules sharing a P0–P3 + verdict contract. `VERDICT: APPROVED` only when no P0/P1/P2 remain.

| Module | What it does |
|--------|--------------|
| **codereview** | pi-dw `/code-review`: **7 finder angles** (A/B/C correctness, D/E/F cleanup, G altitude). Each verified 3-way (CONFIRMED/PLAUSIBLE/REFUTED — REFUTED dropped), deduped by `file:line:summary`, ranked correctness > cleanup > altitude. Cap `MAX_DIFF_CHARS` (200000). |
| **auditcode** | **10-section** self-checklist (Supply Chain & Security, Provenance & Metadata, Law of Demeter, …). `--gate` exits 1 on any failure; `qualityScore = 100*(total − must − should)/total`. |
| **requestreview** | **Dual-blind AND-gate**: two independent reviewers must **both** pass (`mustFix == 0 && score >= threshold`). Bounded by `MAX_REVIEW_ITERATIONS` (5). **Delta-review:** round 1 comprehensive; from round 2 each auditor verifies its OWN prior findings as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED (only regressions traceable to a fix are added). |
| **respondreview** | `categorize` (must/should/consider) + `applyOrder` (severity). If `apply_fixes`, applies in order then re-runs test/typecheck/lint. Every finding addressed. |

### `/sf-flow-audit` vs the `code-review` flow

Both run the same audit triad, so they look interchangeable — but the wrapper matters:

| | `/sf-flow-audit` | `sf_flow_auto code-review` |
|---|---|---|
| Tier | 1 (built-in skill) | 2 (YAML flow) |
| What runs | the skill inline, in your current session | a generated pi-dw script that runs the skill phase INLINE — the orchestrator reads + executes the skill file (no nested agent) |
| Model source | config (`reviewer.model`) | config (`reviewer.model`) — *via the skill* |
| Result | findings + verdict into your chat | a flow result — the skill phase's `out` is **opaque** (a placeholder string) |
| Gated loop | no (one-shot; `apply_fixes` applies once) | **yes** — audit↔fix group loop (auditor gates, developer fixes, re-verify until APPROVED) |
| Extensible | fixed skill steps | edit the YAML: add phases, chain it, version & share it |
| Input | `target` (git ref / file / `workdir`) | `prompt` · `md-file` · `prd` · `jira` |

Today `code-review.yaml` is an audit↔fix **group loop**: the auditor agent gates (finds P0-P3 + verdict), the developer agent fixes, and the auditor re-verifies until APPROVED or max_rounds. This gives it a structural advantage over the one-shot skill: findings are addressed and re-verified in a loop. **Use the skill** for a quick, zero-overhead audit in your current task. **Use the flow** when you want a reusable, shareable, composable artifact with a gated fix loop — e.g. chain it after plan + implement (that's `ship-feature.yaml`). Remember: a flow's **agent** phases get their model from the YAML (`agents.<name>.model`); its **skill** phases inherit the skill's config-driven model.

> **Group loops are the fix mechanism.** The gate phase finds issues → the fix phase modifies code → the gate re-verifies → until APPROVED. Without the fix phase, the gate would see the same artifact each round and the loop could never close.

> **Want a gated audit loop in your own flow?** Use a `groups` entry with an auditor gate phase + developer fix phase, and a matching `loops` entry with `until: approved`. The `code-review` flow demonstrates this pattern. A `skill` phase can't loop (it returns no structured verdict to gate on) — always use `agent` phases in groups.

---

## Agent resolution

When a skill or phase needs to spawn an agent, the type is resolved deterministically:

1. If an agent definition `<name>.md` exists → spawn that named agent (`name`).
2. Else `planner` → built-in `Plan`; `reviewer` → built-in `Reviewer`.
3. Anything else with no `.md` → `general-purpose`.

A missing `researcher.md` does **not** fall back to the built-in `Explore` (which forces Haiku) — it yields `general-purpose`, inheriting the orchestrator model. This rule is encoded in code (`resolveAgentType`) + stated verbatim in every tier-1 skill, so the direct (tool) path and the workflow (`skill:` phase) path spawn the same agent type.

The orchestrator is **orchestrator-only**: in `/sf-flow-implement` it writes no code — it delegates each milestone to the `developer` agent and runs the per-milestone reviewer gate.

## Plan standard (exhaustive milestone plans)

Plans are consumed by an implementer that may be a weaker model, so `/sf-flow-plan` enforces an **exhaustive** standard: every story must specify exact files + lines, a precise change (no vague verbs like "refactor"/"improve"), rationale, acceptance criteria, edge cases, test expectations, and dependencies — enough that a less-intelligent model can implement it with **zero remaining design decisions**. A completeness self-check runs before finalizing, and the reviewer gate REVISEs under-detailed stories independent of correctness. (This applies to both the plan tool and a workflow's plan phase — both execute the same skill.) The reviewer loop uses **delta-review** for convergence: round 1 is a comprehensive from-scratch review; from round 2 the reviewer verifies each prior finding as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED, and only regressions traceable to a fix are added.

---

## Configuration

Layered: project `.pi/sf/flow/config.json` over global `~/.pi/sf/flow/config.json` over defaults. Partial configs are fine.

```json
{
  "reviewer": { "model": "anthropic/sonnet-4-6" },
  "researcher": { "model": "anthropic/haiku-4-5" },
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
| `<role>.model` | `string` | — | Model for one of the ten agents with a config group: `reviewer`, `researcher`, `developer`, `planner`, `auditor`, `synth`, `designer`. All optional; unset ⇒ inherits the orchestrator (no fail-fast) |
| `elicitor.model` | `string` | — | Model for the `elicitor` agent (questions-phase fallback). Inline YAML `model:` wins; config fallback; env; `.md`; orchestrator |
| `notifier.model` | `string` | — | Model for the `notifier` agent (config-only; no env var). Inline YAML `model:` wins; else config; else `.md`; else orchestrator |
| `scanner.model` | `string` | — | Model for the `scanner` agent (config-only; no env var). Inline YAML `model:` wins; else config; else `.md`; else orchestrator |
| `audit.threshold` | `number` | `0.94` | Dual-blind AND-gate pass score |
| `audit.max_rounds` | `integer` | `5` | Max audit fix-loop iterations |
| `worktree.branch_prefix` | `string` | `flow/` | Branch prefix for implement worktrees |

**Environment variables:** `SF_FLOW_REVIEWER_MODEL`, `SF_FLOW_RESEARCHER_MODEL`, `SF_FLOW_DEVELOPER_MODEL`, `SF_FLOW_PLANNER_MODEL`, `SF_FLOW_AUDITOR_MODEL`, `SF_FLOW_SYNTH_MODEL`, `SF_FLOW_DESIGNER_MODEL`, `SF_FLOW_ELICITOR_MODEL`.

### Model resolution chain (Tier 1 skills)

Tier-1 skills **self-resolve** each agent's model: 1. a model passed in the invocation context (tool echo / workflow hint) → 2. config (`<role>.model`, project then global) → 3. env (`SF_FLOW_<ROLE>_MODEL`) → 4. **inherit the orchestrator model** (uniform fallback, no fail-fast). At dispatch, an unset model is *omitted* so pi-subagents applies the agent `.md` `model:` (if any) or inherits the orchestrator.

> Tier 2 YAML agents use inline `model:` first (inline wins); an agent whose name matches a config group then falls back to `config.json`'s `<name>.model`, else `.md`, else orchestrator.

> **Exception — `questions:`-phase elicitor:** the elicitor agent resolves inline YAML `model:` → `config.json` `elicitor.model` → env `SF_FLOW_ELICITOR_MODEL` → `.md` → orchestrator (inline YAML wins). This is the only Tier-2 agent with an ENV-var fallback (`SF_FLOW_ELICITOR_MODEL`).

### Model precedence

A common question: *if an agent `.md` sets a `model:` and config sets a different one, which wins?* **10-agent model registry** (`reviewer`/`researcher`/`developer`/`planner`/`auditor`/`synth`/`designer`/`elicitor`/`notifier`/`scanner`); each group is `additionalProperties: false`.

| Agent used by | `.md` `model:` | YAML `model:` | config | → Model used |
|---|---|---|---|---|
| Tier 1 skill | (applied by pi-subagents only if config/env unset) | — | set | **config** |
| Tier 1 skill | (applied if unset) | — | unset | **`.md`** → else **orchestrator** (uniform fallback) |
| Tier 2 flow agent (name-matches-group) | set | set | set | **YAML** (inline wins) |
| Tier 2 flow agent (name-matches-group) | set | omitted | set | **config** (`<name>.model`) |
| Tier 2 flow agent (name-matches-group) | set | omitted | unset | **`.md`** → else **orchestrator** |
| Tier 2 flow agent (no matching group) | set | omitted | — | **`.md`** → else **orchestrator** |
| `questions:` elicitor | set | set | (no effect) | **YAML** (inline wins) |
| `questions:` elicitor | (applied if unset) | omitted | set | **config** (`elicitor.model`) |
| `questions:` elicitor | (applied if unset) | omitted | unset | **`.md`** → else **orchestrator** |

**Why config wins for Tier 1 (when set):** the skill self-resolves + passes the model *explicitly* at dispatch — `Agent({ subagent_type: "reviewer", model: "<from config>" })` — overriding the `.md`. If config/env are both unset, the model is omitted so pi-subagents falls back to the `.md` `model:` (if any), else the orchestrator. The seven default agents ship with no `model:` — so an unset config simply inherits the orchestrator (no error).

**Why YAML wins for Tier 2:** `agentOpts` resolves `def?.model ?? configModel ?? undefined` — inline YAML `model:` always wins. With no inline model, an agent whose name matches a config group (resolved via `configModelFor`) gets the config `<name>.model` baked in; otherwise the model is omitted so pi-subagents falls back to the `.md`'s `model:` (else the orchestrator).

**Exception — the elicitor agent** (used by `questions:` phases) is the one Tier-2 agent with an ENV-var fallback (`SF_FLOW_ELICITOR_MODEL`): its model resolves inline YAML `model:` → `config.json` `elicitor.model` → env `SF_FLOW_ELICITOR_MODEL` → `.md` → orchestrator (inline YAML wins). A present-but-malformed `elicitor.model` normalizes to `null` and blocks the env fallback (mirrors tier-1 config-present semantics).

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

**From `team`:** plan/implement → `sf_flow_plan` / `sf_flow_implement`; audit → `sf_flow_audit`; user workflows → Tier 2 YAML. Dropped: subprocess orchestration, parallel lanes. `flow` imports neither `@pi-stef/agent-workflows` nor any deprecated package, so it cannot be broken by their removal.

**From `pair`:** flow adds a fleet of parallel researchers, an audit triad gate, Tier 2 custom workflows, and a standalone `sf_flow_audit` — on the pi-subagents + pi-dynamic-workflows foundation.

## Agent isolation

Agents spawn either isolated (`isolated: true`: fresh context, extensions/`ext:*` tools stripped) or un-isolated (`isolated: false`: inherits parent, extensions loaded per `extensions:` frontmatter). Among the built-ins, **only `researcher` is un-isolated**; everything else stays isolated. The agent `.md` frontmatter is authoritative — a flow YAML can only flip `isolated:`, not grant extensions (edit the `.md` for that).

## Authenticated source access

An un-isolated `researcher` can reach private sources: **private GitHub** via `gh pr view`/`gh pr diff` (works even when isolated, through `bash`); **Confluence / Jira** via the `@pi-stef/atlassian` tools + `ATLASSIAN_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` env; **SSO fallback** via `sf_web_login` (once) then `sf_web_fetch { profile, mode: "browser" }`.

Full guide: https://sfiorini.github.io/pi-stef/guides/agent-isolation-and-auth

## License

MIT
