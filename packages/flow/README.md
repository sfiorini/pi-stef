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
| **Agent** | A role's *behavior* — a system prompt + frontmatter (`model:`, `tools`, `thinking`, `isolated`, …). The `.md` is the agent's single definition, model included; flow passes no model at dispatch. | `~/.pi/agent/agents/<name>.md` (global) or `.pi/agents/<name>.md` (project overrides global) | flow ships **12 defaults**; you edit/add freely (write-once) |
| **Workflow** | *What runs, in what order* — either a built-in skill (Tier 1) or a YAML file (Tier 2). | Tier 1: built-in skills · Tier 2: `~/.pi/sf/flow/workflows/<name>.yaml` (global defaults) or `.pi/sf/flow/workflows/<name>.yaml` (project override) | flow ships skills + **5 example YAMLs** (`/sf-flow-seed`); you add YAMLs |
| **Config** | *Runtime settings* — audit thresholds + worktree (models live in the agents' `.md` files). | `~/.pi/sf/flow/config.json` (global) + `.pi/sf/flow/config.json` (project) | you (partial is fine) |

> ### ⚠️ Agents are defined in exactly one place: their `.md` file
> Each agent (reviewer, researcher, developer, planner, auditor, synth, designer, elicitor, notifier, scanner, explorer, analyst) is **defined as a `.md` file** — frontmatter (`model:`, `tools`, `thinking`, `isolated`, …) plus the body (its system prompt). Discovery: project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`. Neither `config.json` nor workflow YAMLs define agents or their models: config carries only runtime settings (`audit`, `worktree`), and a workflow only *names* the agents its phases use. Set an agent's model by editing its `.md`.

**Where the model comes from:**

- **Every agent, in every tier** — its `.md` frontmatter `model:` (project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`); a `.md` with no `model:` inherits the orchestrator. Flow passes no model at dispatch.

---

## Quickstart

```bash
# 1. Audit your current diff — zero config, runs the 7-angle triad + dual-blind gate
/sf-flow-audit

# 2. Plan, then implement a feature (agent models come from their .md files)
/sf-flow-plan add OAuth login
/sf-flow-implement 2026-07-20-oauth-login

# 3. Run a reusable flow end-to-end (seed the 5 examples to ~/.pi/sf/flow/workflows via /sf-flow-seed)
sf_flow_auto code-review "review the auth changes"
```

Or in natural language:

```
"Plan a feature for adding user authentication"  # reviewer model: edit reviewer.md
"Implement the plan in ai_plan/2026-07-20-oauth-login"
"Run the code-review flow on the staged diff"
```

---

## Built-in agents

Twelve write-once agent definitions ship in `packages/flow/agents/` and are copied to your **global** discovery dir (`getAgentDir()/agents/`, default `~/.pi/agent/agents/`) by `/sf-flow-seed` (or lazily on first use of a Tier 1 skill):

| Agent | Role | `tools` | `thinking` | Tier |
|-------|------|---------|-----------|------|
| `planner` | Workflow Planner — milestones + stories | read, grep, find, ls, write, edit | medium | opus |
| `designer` | Workflow Designer — design via brainstorming (2–3 approaches → recommend 1) | read, grep, find, ls | high | opus |
| `developer` | TDD Developer — red/green/refactor | read, grep, find, ls, write, edit, bash | medium | opus |
| `reviewer` | Plan/Implementation Reviewer | read, grep, find, ls | high | sonnet |
| `auditor` | Code Auditor (CodeRabbit-style) | read, grep, find, ls | high | sonnet |
| `synth` | Synthesis / Report Writer | read, write | medium | opus |
| `scanner` | Route/File Scanner — enumerate files for fan-out | read, grep, find, ls | low | haiku |
| `elicitor` | Requirements Elicitor — clarifying questions | read, grep, find, ls | high | sonnet |
| `researcher` | Researcher — codebase + web + private-source research, cited claims | read, grep, find, ls, bash, `ext:web/*` + `ext:atlassian/*` | medium | opus |
| `notifier` | Notifier — Telegram completion summary (opt-in, Tier-2) | bash | low | haiku |
| `explorer` | Explorer — fast read-only codebase/document scout, cited findings | read, grep, find, ls | low | sonnet |
| `analyst` | Analyst — deep-research intake coordinator + synthesis report writer | read, write, bash | high | opus |

- **Write-once:** flow *never* overwrites an existing agent file — edit any of them freely.
- **Model resolution:** each agent's model comes from its `.md` frontmatter — project `.pi/agents/<name>.md` overrides the global one; a `.md` with no `model:` inherits the orchestrator. Never pass a model at dispatch.
- **Project overrides global:** `<repo>/.pi/agents/reviewer.md` shadows the global one.
- **Every shipped `.md` carries a commented model hint** naming the tier the agent needs — opus-class (frontier reasoning: planner, designer, developer, researcher, analyst, synth), sonnet-class (review/scout: reviewer, auditor, elicitor, explorer), or haiku-class (super-light: scanner, notifier) — with cross-provider example IDs. Uncomment `model: <provider>/<modelId>` and set your preferred model before your first run (full `provider/modelId`; never a bare alias, which one pi-subagents spawn path silently drops). With no `model:` the agent **inherits the orchestrator**; flow never passes a model at dispatch (see [Model resolution](#model-resolution)). `researcher` is the **only** agent with `isolated: false` and `extensions: [web, atlassian]` (declared in its `.md` frontmatter) — see [Agent Isolation & Auth](https://sfiorini.github.io/pi-stef/guides/agent-isolation-and-auth). `notifier` is an opt-in agent that sends a one-line completion summary via the bundled `notify-telegram.sh` when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (returns `skipped` silently otherwise) — name it in a workflow's `agents:` block and run it from a final `notify` phase. `explorer` + `analyst` power the `deep-research` flow (bound via `agentType`).

**Add a new agent:** drop a `<name>.md` at `~/.pi/agent/agents/` (global) or `.pi/agents/` (project), then reference it by name in a workflow's `agents:` block. The `/sf-flow-create-workflow` interview also emits a write-once stub for any named agent that doesn't yet exist (the interview writes it; the tool itself only writes the YAML + registers).

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

Phases: fan out N researchers in parallel → codebase map → gather requirements one question at a time → design (brainstorming) → plan (writing-plans: milestones + `S-MN{seq}` stories) → **delta-review** iterative reviewer loop (round 1 comprehensive, round 2+ verifies prior findings as FIXED / PARTIALLY-FIXED / NOT-FIXED / NEW-ISSUE-INTRODUCED; max 10 rounds) → write plan files → optional Telegram notify.

### sf_flow_implement

Execute an approved plan in **one** worktree (`flow/<slug>`, git-only), TDD per story, audit triad as a **non-optional gate** before commit.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Plan folder slug or path under `ai_plan/` |

Per-milestone: TDD each story → **delta-review** reviewer loop (round 1 comprehensive, round 2+ verifies prior findings; max 5 rounds) → commit to worktree branch → update tracker. After all milestones: run `sf_flow_audit` on the accumulated diff; on `REVISE` loop back to the failing **story** (bounded by `audit.max_rounds`, default 5). Finish with `sf_flow_finalize`.

### sf_flow_audit

CodeRabbit-style audit returning P0–P3 + verdict (`APPROVED` / `REVISE`). See the [audit triad](#code-audit-triad).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `target` | No | Diff target: git ref range, file path, or `workdir`. Defaults to `git diff HEAD` |
| `apply_fixes` | No | If true, run respond-review to apply must-fix / should-fix |

### sf_flow_auto

Run a defined flow end-to-end with **no human gates**.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workflow` | Yes | Flow name (resolved project→global: `.pi/sf/flow/workflows/<name>.yaml` overrides `~/.pi/sf/flow/workflows/<name>.yaml`) |
| `input` | Yes | `prompt` · path to a markdown file · `prd:<path>` · `jira STORY-123` |

### sf_flow_create_workflow

Adaptive wizard that consults local bundled example workflows to suggest building blocks by task archetype. Validates each section incrementally (partial) or full cross-field (complete). Writes the YAML + registers `/<name>` (the interview also emits write-once agent stubs for any agent without an .md).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | kebab-case flow name |
| `description` | No | One-liner |
| `input` | No | `prompt` / `md-file` / `prd` / `jira` |
| `agents_yaml` | No | Pre-formed agents YAML to skip the interview — a LIST of names (e.g. `- scanner\n- auditor`) |
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
agents: [scanner, auditor, synth]        # names only — the .md files define the agents
phases:
  - { id: scan,   agent: scanner,  prompt: "List every route file under src/routes/.", out: files }
  - { id: audit,  agent: auditor,  fanout: files, prompt: "Audit {{item}} for missing auth checks.",
      schema: { verdict: "APPROVED|REVISE" }, out: findings }
  - { id: verify, agent: auditor,  verify: findings, threshold: 0.66, out: confirmed }
  - { id: report, agent: synth,    in: confirmed, prompt: "Write a cited report from these findings." }
loops:
  audit: { until_dry: true, max_rounds: 3, dedup_key: "{{file}}:{{line}}:{{summary}}" }
```

Run it: `sf_flow_auto auth-audit "check the API routes"`.

### Knob 1 — `agents`

A **list of agent names** — just the names this flow uses. The agents themselves (system prompt, `model:`, `tools`, `thinking`, `isolated` — everything) are **defined in their `.md` files** (project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`); a workflow never defines an agent or its model. To change an agent's model or tools, edit its `.md`.

### Knob 2 — `phases`

An ordered list. **Each phase runs exactly one of** `agent` / `skill` / `raw` / `questions`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Phase identifier (referenced by `loops`) |
| `agent` | `string` | Run an agent (must be named in `agents`) |
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
| `schema` | `object` | The PHASE's structured-output contract (e.g. `{ verdict: APPROVED\|REVISE, findings: array }`); required on gate phases for `until: approved` (+ `findings` for `canonical-delta`), `{ questions: array }` on elicitor phases |
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
| `protocol` | gate | `raw` (default — fresh review each round) · `canonical-delta` (carry `[Fn]`-numbered findings across rounds and AND-gate via verification each round ≥2; group-only, requires the gate PHASE's `findings` schema + `until: approved`) |

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
| 14 | `loops.<key>` that matches a group with `until: approved`: the GATE PHASE must declare a `schema.verdict` |
| 15 | `loops.<key>` that matches a phase: must reference an existing phase |
| 16 | Loops are **not** allowed on `skill` phases |
| 17 | Loops are **not** allowed on `raw` phases |
| 18 | Loops are **not** allowed on `questions` phases (the follow-up loop is built-in) |
| 19 | `until_dry` **requires** the phase to set `fanout` |
| 19a | `until: approved` on a phase loop **requires** the gate PHASE to declare a `schema.verdict` |
| 20 | `inputs.require` names must resolve to a prior `out`/`publish` or a built-in (`input`/`flow`) — else unresolved |
| 21 | `worktree: finalize` requires a preceding `worktree: prepare` phase |
| 22 | artifact `template` refs must resolve (`@flow/…` or an existing path) |
| 23 | `publish` names must be valid identifiers; `{{slug}}`/`{{dir}}` require `outputs.slug`/`outputs.dir`; a bare value must be the phase `out` or a `require`d input (else it would emit an undefined ref) |
| 24 | `protocol: canonical-delta` requires a group loop, `until: approved`, and the gate PHASE's `findings` schema |

> **Caveat (rule 19a):** the guard checks `schema.verdict` presence only. An agent that declares a verdict schema but has no finding-capable tools (e.g. read-only with no analysis prompt) will always `APPROVE` — this is not structurally detectable.

> **Fail-closed gate (D4).** A gate result approves ONLY with a string `verdict === "APPROVED"` AND no blocking finding. `null`/`{}`/a `REVISE` with no findings/ an `APPROVED` with a blocking finding all reject — group and single-phase gates share one `_gateApproved` predicate.

### Defining a new flow

- **Wizard** — `/sf-flow-create-workflow` (adaptive: suggests building blocks from local examples, validates sections incrementally, writes YAML + agent stubs, registers `/<name>`).
- **By hand** — create `.pi/sf/flow/workflows/<name>.yaml` (project) or `~/.pi/sf/flow/workflows/<name>.yaml` (global), then `sf_flow_auto <name> <input>` (validates + generates eagerly).

### Upgrading from the old format (pre-0.12)

Workflow YAMLs written before the agents-as-definitions change **fail validation** at registration with a warning explaining the new shape. Migrate by hand:

1. **`agents:` is now a list of names.** `agents: { scanner: { tools: [...], model: haiku } }` → `agents: [scanner]`. Delete every per-agent field (`tools`, `model`, `thinking`, `isolated`, `schema`) from the YAML.
2. **Move each agent's `schema` onto the phase(s) that need it** — a gate phase's `verdict`/`findings` contract is a property of the *phase*, not the agent (the same agent can gate in one phase and return prose in another). An elicitor phase carries `{ questions: array }`.
3. **Move `tools`/`model`/`thinking`/`isolated` into the agent's `.md` frontmatter** (project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`). To pin a model, set `model: provider/modelId` in the `.md`.
4. **Config model groups are gone** — a `config.json` carrying `<role>.model` groups still loads (they are stripped with a one-time warning); move those models into the `.md` files.
5. **`SF_FLOW_<ROLE>_MODEL` env vars and the `*_model` tool params are gone** — set the model in the agent's `.md` instead.
6. **`raw:` phases:** inline `model:`/`tools:`/`thinking:`/`isolated:` in `agent()` calls still work but duplicate the `.md` definitions — bind calls with `{ label, phase, agentType }` (+ `schema` when the result is consumed) so the `.md` drives everything.

Run `/sf-flow-seed` to copy the new-format bundled examples beside your existing files (as `<name>.new`) for side-by-side migration.

### Notifications in custom workflows (Tier-2, opt-in)

Flow ships an opt-in **notifier** agent that sends a one-line completion summary to Telegram via the bundled `notify-telegram.sh` script. It is a normal Tier-2 agent — name it and run it from a final phase in any custom workflow (its tools/thinking/isolation live in `notifier.md`):

```yaml
agents: [notifier]
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
| Model source | agent `.md` frontmatter | agent `.md` frontmatter |
| Result | findings + verdict into your chat | a flow result — the skill phase's `out` is **opaque** (a placeholder string) |
| Gated loop | no (one-shot; `apply_fixes` applies once) | **yes** — audit↔fix group loop (auditor gates, developer fixes, re-verify until APPROVED) |
| Extensible | fixed skill steps | edit the YAML: add phases, chain it, version & share it |
| Input | `target` (git ref / file / `workdir`) | `prompt` · `md-file` · `prd` · `jira` |

Today `code-review.yaml` is an audit↔fix **group loop**: the auditor agent gates (finds P0-P3 + verdict), the developer agent fixes, and the auditor re-verifies until APPROVED or max_rounds. This gives it a structural advantage over the one-shot skill: findings are addressed and re-verified in a loop. **Use the skill** for a quick, zero-overhead audit in your current task. **Use the flow** when you want a reusable, shareable, composable artifact with a gated fix loop — e.g. chain it after plan + implement (that's `ship-feature.yaml`). Remember: every phase's agents get their model from their `.md` files (both tiers).

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
  "audit": { "threshold": 0.94, "max_rounds": 5 },
  "worktree": { "branch_prefix": "flow/" }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `audit.threshold` | `number` | `0.94` | Dual-blind AND-gate pass score |
| `audit.max_rounds` | `integer` | `5` | Max audit fix-loop iterations |
| `worktree.branch_prefix` | `string` | `flow/` | Branch prefix for implement worktrees |
| `freshReviewResetThreshold` | `number` | `0.5` | Reset the delta-review to a fresh comprehensive review when the changed-lines ratio meets/exceeds this |

Models are NOT configured here — each agent's model lives in its `.md` frontmatter
(see [Model resolution](#model-resolution)). Config files still carrying legacy
`<role>.model` groups are stripped with a one-time warning.

### Model resolution

Agents' models are defined in ONE place: each agent's `.md` frontmatter (`model:`).
Discovery: project `.pi/agents/<name>.md` overrides global `getAgentDir()/agents/<name>.md`
(default `~/.pi/agent/agents/`); a `.md` with no `model:` inherits the orchestrator.
Flow passes no model at dispatch — pi-subagents applies the `.md` model natively
(frontmatter is authoritative), in tier-1 skills and tier-2 workflow agents alike.

> The old model channels — `config.json` model groups, `SF_FLOW_<ROLE>_MODEL` env vars,
> the `*_model` tool params, and the workflow YAML's per-agent `model:` field — were
> removed. Config carrying model groups is stripped with a one-time warning; set the
> model in the agent's `.md` instead.

## Architecture

- **Skill-driven design** — the tools are thin: each ensures agents exist + reports each agent's `.md` (path + carried model, read-only), then hands off to a `SKILL.md` with the step sequence. The extension provides only config loading (runtime settings), write-once agent templates, agent-type resolution, and worktree helpers.
- **Model resolution** — each agent's model lives in its `.md` frontmatter (project `.pi/agents` overrides global); flow passes no model at dispatch. Agent types resolve by `.md` filename match (see [Agent resolution](#agent-resolution)).
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

Agents spawn either isolated (`isolated: true`: fresh context, extensions/`ext:*` tools stripped) or un-isolated (`isolated: false`: inherits parent, extensions loaded per `extensions:` frontmatter). Among the built-ins, **only `researcher` is un-isolated**; everything else stays isolated. The agent `.md` frontmatter is authoritative — a flow YAML only NAMES agents; isolation, tools, and extensions are all `.md`-only (edit the `.md` to change them).

## Authenticated source access

An un-isolated `researcher` can reach private sources: **private GitHub** via `gh pr view`/`gh pr diff` (works even when isolated, through `bash`); **Confluence / Jira** via the `@pi-stef/atlassian` tools + `ATLASSIAN_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` env; **SSO fallback** via `sf_web_login` (once) then `sf_web_fetch { profile, mode: "browser" }`.

Full guide: https://sfiorini.github.io/pi-stef/guides/agent-isolation-and-auth

## License

MIT
