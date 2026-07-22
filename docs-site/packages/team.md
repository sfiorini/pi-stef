# team

> ⚠️ **DEPRECATED.** `@pi-stef/team` is deprecated in favor of [`@pi-stef/flow`](/packages/flow). See [Migrating from team & pair](/migrating-from-team-and-pair) for the mapping (`sf_team_plan`→`sf_flow_plan`, `sf_team_implement`→`sf_flow_implement`, `sf_team_task`/`sf_team_auto`→`sf_flow_auto`). Resume = re-run `sf_flow_implement <slug>`; steering = native pi steering; parallelism = multi-agent fan-out.

`@pi-stef/team` runs a small **team of role-agents** (planner, developer, reviewer, researcher) as `pi` subprocesses to drive plan / implement / task / auto / followup workflows.

Use it for larger code changes where you want a durable plan folder, reviewer-approved milestones, resumable orchestration, configurable verification gates, and optional tmux side panes without asking a single model to hold the entire workflow in memory.

## Installation

```bash
pi install npm:@pi-stef/team
```

For project-local install:

```bash
pi install -l npm:@pi-stef/team
```

## Workflows

| Workflow | Start tool | Description |
| --- | --- | --- |
| Plan only | `sf_team_plan` | Researcher → Q&A → planner-draft → reviewer loop → 5-file plan folder |
| Implement | `sf_team_implement` | Read plan → worktree → milestone lanes → reviewer → verify → commit |
| Task | `sf_team_task` | Full end-to-end single-task: plan → implement → review → verify → commit |
| Auto | `sf_team_auto` | Chains plan + implement, no human gates |
| Follow-up | `sf_team_followup` | Creates a follow-up plan against a completed plan |
| Resume | `sf_team_resume` | Resumes any interrupted workflow |
| Steer | `sf_team_steer` | Sends instructions to an active workflow |

### What each workflow does

- **plan**: researcher (analyze brief + repo) → Q&A → external-context fetch → planner-draft → reviewer loop → write 5-file plan folder.
- **implement**: read plan folder → optional worktree → strategy-aware milestone/story lanes when safe → reviewer loop → configured verification hook → commit/merge → user-gate → final pr-description.
- **task**: full end-to-end single-task workflow: plan-review → implement → impl-review → configured verification hook → commit → push decision → pr-description.
- **auto**: chains `sf_team_plan` and `sf_team_implement`, no human gates between.
- **followup**: resolves the parent plan, drafts and implements a follow-up against it as a brand-new sibling plan folder.
- **steer**: appends a user instruction to the durable steering inbox for an active workflow.

## Quickstart

```bash
# Install
pi install npm:@pi-stef/team

# Draft a plan
sf_team_plan title="Add per-org rate limiting" brief="..."

# Implement the plan
sf_team_implement slug=2026-05-01-add-per-org-rate-limiting

# Or chain plan + implement autonomously
sf_team_auto title="Refactor auth module"

# Single-task end-to-end
sf_team_task title="Fix race in cache eviction"

# Resume an interrupted workflow
sf_team_resume resume=2026-05-06-refactor-auth
```

## Natural Language Usage

The agent understands natural-language requests and routes them to the correct tool.

**Draft a plan:**
```text
"Plan out adding per-org rate limiting with milestones, reviewer approval, and a durable plan folder."
"Create a multi-milestone plan for refactoring the auth module. The reviewer should use Claude Opus."
```

**Implement an approved plan:**
```text
"Implement the plan at ai_plan/2026-05-01-add-rate-limiting, milestone by milestone."
"Run sf_team_implement on the approved plan folder and stop before pushing."
```

**End-to-end single task:**
```text
"Fix the cache eviction race: reproduce it, add a regression test, fix it, get review, and commit locally."
"Do a full task workflow: plan, implement, review, verify, and commit a fix for the broken pagination."
```

**Plan + implement chained (fully autonomous):**
```text
"Plan and implement adding per-org rate limiting with no human gates. Use Claude Opus as reviewer."
"Auto-plan and auto-implement: upgrade the notification system to use websockets."
```

**Follow up on a completed plan:**
```text
"Create a follow-up to the rate-limiting plan that adds per-endpoint metrics."
```

**Resume an interrupted workflow:**
```text
"Resume the interrupted auto workflow from 2026-05-06-refactor-auth and continue from its saved checkpoints."
```

**Steer an active workflow:**
```text
"Tell the running workflow not to touch the public cache interface — adapt internals only."
```

## Slash Commands

| Command | Args | Example |
|---------|------|---------|
| `/sf-team-plan` | `<title>` | `/sf-team-plan Add per-org rate limiting` |
| `/sf-team-implement` | `<slug>` | `/sf-team-implement 2026-05-01-add-rate-limiting` |
| `/sf-team-task` | `<title>` | `/sf-team-task Fix race in cache eviction` |
| `/sf-team-auto` | `<title>` | `/sf-team-auto Refactor auth module` |
| `/sf-team-followup` | `<title>` | `/sf-team-followup Add metric for cache evictions` |
| `/sf-team-steer` | `<instruction>` | `/sf-team-steer Do not touch the public cache interface` |
| `/sf-team-resume` | `[slug]` | `/sf-team-resume 2026-05-06-add-rate-limit` |

## Tools

All tools use the `sf_team_` prefix to avoid collisions with other Pi extensions.

| Workflow | Start tool | Resume tool |
| --- | --- | --- |
| Plan only | `sf_team_plan` | `sf_team_resume` |
| Implement an approved plan | `sf_team_implement` | `sf_team_resume` |
| End-to-end single task | `sf_team_task` | `sf_team_resume` |
| Plan + implement chained | `sf_team_auto` | `sf_team_resume` |
| Follow-up against a completed plan | `sf_team_followup` | `sf_team_resume` |
| Steer an active workflow | `sf_team_steer` | none |

### Schemas per tool

| Tool | Required key | Optional keys |
| --- | --- | --- |
| `sf_team_plan` | **`title`** | `brief`, `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_implement` | **`slug`** | `mode`, `maxRounds`, `useWorktree`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_task` | **`title`** | `brief`, `maxRounds`, `allowDirty`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_auto` | **`title`** | `brief`, `maxRounds`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_followup` | **`title`** | `brief`, `parentPlan`, `allowDirty`, `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_resume` | *(none)* | `resume`, `maxRounds`, `allowDirty`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `sf_team_steer` | **`instruction`** | `workflowId`, `planSlug`, `priority`, `targetHints`, `aiPlanPath` |

## Start A Workflow

Use natural language when you want the agent to pick the right workflow:

```text
pi "Use sf_team_auto to plan and implement adding per-org rate limiting. Use Claude Opus as reviewer and stop before pushing."
pi "Use sf_team_task for a small bug fix: reproduce the cache eviction race, add a regression test, fix it, get review, and commit locally."
```

Use exact tool calls when you already know the workflow and inputs:

```text
sf_team_plan title="Add per-org rate limiting" brief="Create a reviewed milestone plan only."
sf_team_implement slug=2026-05-01-add-per-org-rate-limiting
sf_team_auto title="Refactor auth module" brief="Plan, implement, review, verify, and commit locally."
sf_team_task title="Fix race in cache eviction"
sf_team_followup title="Add metric for cache evictions" parentPlan=2026-05-01-cache-eviction
sf_team_steer planSlug=2026-05-01-cache-eviction instruction="Before continuing, make the metric name configurable."
```

### Running outside a git repository

Pass `gitMode=off` and optionally supply `aiPlanPath`:

```text
sf_team_plan title="Upgrade Postgres to 17" gitMode=off aiPlanPath=~/research/2026-Q2
sf_team_task title="Audit breaking changes in react-router v7" gitMode=off
sf_team_auto title="Refactor auth module" gitMode=off aiPlanPath=~/work/plans
```

## Steer Active Workflow

Use `sf_team_steer` when a workflow is already running and you need to amend its next decision:

```text
sf_team_steer workflowId=fhw_implement_20260517094530_ab12cd34 instruction="Restart the current developer with the stricter API constraint."
sf_team_steer planSlug=2026-05-01-cache-eviction instruction="Do not touch the public cache interface; adapt internals only."
```

When exactly one sf-team workflow is active, `instruction` alone is accepted. When multiple active workflows match, the tool returns candidate workflow ids.

Steering can apply future guidance, restart or stop running agents, request confirmation before destructive worktree discard, amend a milestone plan, or mark completed stories/milestones as `needs-rework`.

## Resume Interrupted Workflow

```text
pi "Resume the interrupted sf_team_auto workflow from 2026-05-06-refactor-auth and continue from its saved checkpoints."
```

Technical exact-resume calls:

```text
sf_team_resume resume=2026-05-06-add-rate-limit
sf_team_resume resume=./ai_plan/2026-05-06-add-rate-limit
sf_team_resume
```

## Architecture

The TypeScript orchestrator owns the state machine. Each role-agent is a single-job pi subprocess: receive a typed payload, produce content, exit. Review loops alternate role-agent spawns and reviewer spawns; agents do not spawn other agents.

Roles:
- **researcher** — read-only analyzer. Inspects brief + repo state, emits structured findings JSON.
- **planner** — drafts the milestone plan. Receives researcher findings + Q&A answers as context.
- **developer** — implements one milestone at a time. Bound by strict TDD contract.
- **reviewer** — strict isolation, read-only tools. Verdict format: `## Summary` / `## Findings` (P0–P3) / `## Verdict`.

## TDD Policy

Every developer agent is bound by a strict test-first contract. Before writing any non-test code the developer MUST:

1. Write the test(s) that capture the new/changed behavior in a `*.test.ts` file colocated with existing tests.
2. Run them with a TARGETED command and confirm RED — the failure is on the new behavior.
3. Implement the change. Stage only the files touched.
4. Re-run the same targeted command and confirm GREEN.

The handoff prose to the reviewer MUST contain a `## TDD proof` section with:
- `### Tests added` — file paths + test names
- `### Red` — verbatim output of step 2
- `### Implementation` — one-line summary of what changed
- `### Green` — verbatim output of step 4

When the staged diff is genuinely test-irrelevant (docs, README, `package.json` bumps), the developer may replace the proof block with:

```text
no-test-needed: <one-sentence reason citing why no behavior changed>
```

## Configuration

Layered global + project config, with project winning at field level:

- Global: `~/.pi/sf/team/config.json`
- Project: `<repo>/.pi/sf/team/config.json`

Resolution chain: `prompt args → project config → global config → DEFAULT_CONFIG`.

### Agent Models

```jsonc
{
  "agents": {
    "planner":    { "model": "claude-sonnet-4-6", "thinking": "medium", "heartbeatMs": 300000 },
    "reviewer":   { "model": "claude-sonnet-4-6", "thinking": "high",   "heartbeatMs": 600000 },
    "developer":  { "model": "claude-sonnet-4-6", "thinking": "medium", "heartbeatMs": 600000 },
    "researcher": { "model": "claude-haiku-4-5",  "thinking": "low",    "heartbeatMs": 300000 }
  }
}
```

### Review Budget

```jsonc
{
  "review": {
    "max_rounds": 10,
    "plan_max_rounds": 10,
    "implementation_max_rounds": 10
  }
}
```

### Verification Policy

```jsonc
{
  "implement": {
    "verification": {
      "timing": "after",
      "mode": "commands",
      "stages": ["typecheck", "test"],
      "cache": { "mode": "run" },
      "maxAttempts": 2
    }
  }
}
```

| Tool config | Default timing | Default stages |
| --- | --- | --- |
| `plan.verification` | `off` | `typecheck`, `test` |
| `implement.verification` | `after` | `typecheck`, `test` |
| `auto.verification` | `after` | `typecheck`, `test` |
| `task.verification` | `after` | `typecheck`, `test` |
| `followup.verification` | `after` | `typecheck`, `test` |

### Model IDs

`pi` resolves bare model ids by scanning all registered providers. Qualify with provider prefix when needed:

```jsonc
{
  "agents": {
    "planner":    { "model": "openai-codex/gpt-5.3-codex", "thinking": "medium" },
    "reviewer":   { "model": "openai-codex/gpt-5.2",       "thinking": "low" },
    "developer":  { "model": "claude-haiku-4-5",            "thinking": "medium" },
    "researcher": { "model": "openai-codex/gpt-5.4-mini",   "thinking": "medium" }
  }
}
```

Anthropic ids are unambiguous (only `anthropic` registers them), so `claude-*` works without a prefix. Run `pi --list-models` to see the full provider/model table.

### Speed Profiles

Quality-first (Opus-heavy):

```jsonc
{
  "agents": {
    "planner":    { "model": "claude-opus-4-7", "thinking": "high" },
    "reviewer":   { "model": "claude-opus-4-7", "thinking": "xhigh" },
    "developer":  { "model": "claude-opus-4-7", "thinking": "high" },
    "researcher": { "model": "claude-opus-4-7", "thinking": "medium" }
  }
}
```

Faster/lower-cost:

```jsonc
{
  "agents": {
    "planner":    { "model": "claude-haiku-4-5",  "thinking": "low" },
    "reviewer":   { "model": "claude-sonnet-4-6", "thinking": "medium" },
    "developer":  { "model": "claude-sonnet-4-6", "thinking": "low" },
    "researcher": { "model": "claude-haiku-4-5",  "thinking": "low" }
  }
}
```

## Headless Mode

Use headless mode for fast local runs, CI-like runs, or performance investigations:

```jsonc
{
  "workflow": { "profile": "headless" }
}
```

Headless mode changes workflow behavior:
- Suppresses interactive UI prompts
- Disables tmux pane mirroring
- Applies faster review defaults: `plan_max_rounds=3`, `implementation_max_rounds=4`, `max_rounds=4`

Override the review budget when needed:

```jsonc
{
  "workflow": { "profile": "headless" },
  "review": { "plan_max_rounds": 2, "implementation_max_rounds": 5 }
}
```

## Inter-Milestone Pause

Both `implement` and `auto` accept `pause_between_milestones` (boolean):

| Tool | Default | Rationale |
|------|---------|-----------|
| `implement` | `true` | User inspects each milestone's diff before continuing |
| `auto` | `false` | Auto runs end-to-end unless explicitly opted in |

```jsonc
// Make auto pause between milestones
{ "auto": { "pause_between_milestones": true } }

// Make implement run end-to-end
{ "implement": { "pause_between_milestones": false } }
```

## Parallel Execution

New plan folders include `execution-strategy.json` for parallel milestone/story lanes:

```jsonc
{
  "parallel": {
    "enabled": true,
    "max_milestones": 3,
    "max_stories_per_milestone": 2,
    "on_conflict": "stop"
  }
}
```

Each parallel story and milestone lane gets its own git worktree and branch. Story lanes commit locally, then merge into the milestone lane in story order. Approved milestone lanes merge into the aggregate implementation branch in strategy order.

Disable parallel execution:

```jsonc
{ "parallel": { "enabled": false } }
```

## Safety Properties

- **Reviewer subprocess isolation** — argv profile is immutable; tested via snapshot
- **Universal secret scan** — centrally enforced in `spawnAgent` so every role spawn is scanned before exec
- **Dirty-worktree guard** — baseline captured + strict staging
- **Mandatory revise callback** — every review loop feeds findings back into a fresh role-agent spawn
- **Per-folder lock** — atomic acquire via `mkdir`; rich metadata
- **Process-tree cleanup on abort** — detached process group, SIGTERM → 2s → SIGKILL

## Empty-Diff Recovery

When the developer agent stages no changes, the implement tool re-prompts the developer up to `implement.empty_diff_retries` times (default 2). Configure:

```jsonc
{
  "implement": {
    "empty_diff_retries": 2,
    "empty_diff_retry_model": "claude-opus-4-7"
  }
}
```

## TDD Mode

`tddMode` controls the test-driven-development policy independently of `gitMode`:

| `tddMode` | Behavior |
| --- | --- |
| `auto` (default) | TDD proof block required for code changes; `no-test-needed:` shortcut allowed for non-code diffs |
| `on` | TDD strictly required. `no-test-needed:` shortcut forbidden |
| `off` | TDD contract waived entirely |

Set globally via config (`tdd.mode`) or pass per call:

```text
sf_team_task title="Fix race in cache eviction" tddMode=on gitMode=off
```

## Plan-Folder Layout

```
ai_plan/<YYYY-MM-DD-slug>/
  ├── original-plan.md
  ├── milestone-plan.md
  ├── story-tracker.md
  ├── continuation-runbook.md
  ├── final-transcript.md
  ├── execution-strategy.json
  ├── pr-description.md
  ├── research-answers.json
  ├── transcript/
  │   ├── planning/
  │   └── implementation/
  ├── diagnostics/
  ├── reports/
  │   └── performance-<ISO-stamp>.md
  └── .pi/sf/agent-workflows/
      ├── workflow.json
      ├── checkpoints.json
      └── steering/
```

## tmux Integration

Each agent can mirror its raw stdout/stderr into a per-agent tmux pane. Panes auto-open on subscribe and auto-close when the agent reaches terminal state.

```
+--------------------------------------+------------------------------+
|                                      | planner > running ...        |
|   pi conversation                    |------------------------------|
|                                      | reviewer > running ...       |
|                                      |------------------------------|
|                                      | developer > running ...      |
+--------------------------------------+------------------------------+
```

Disable with `SF_TEAM_NO_TMUX=1` or `--no-tmux`. If tmux is not installed, sf-team works exactly as before.

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `agents.planner.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `medium`, `300_000` | Planner subprocess |
| `agents.reviewer.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `high`, `600_000` | Reviewer subprocess |
| `agents.developer.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `medium`, `600_000` | Developer subprocess |
| `agents.researcher.{model,thinking,heartbeatMs}` | `claude-haiku-4-5`, `low`, `300_000` | Researcher subprocess |
| `workflow.profile` | `default` | `default` or `headless` |
| `review.max_rounds` | `10` (`4` headless) | Compatibility fallback for both review-loop types |
| `review.plan_max_rounds` | `10` (`3` headless) | Cap on planner ↔ reviewer loops |
| `review.implementation_max_rounds` | `10` (`4` headless) | Cap on developer ↔ reviewer loops |
| `implement.mode` | `single-milestone` | `single-milestone` or `all-milestones` |
| `implement.use_worktree` | `true` | Create a git worktree before implement |
| `implement.branch_prefix` | `implement/` | Branch-name prefix |
| `implement.pause_between_milestones` | `true` | Pause between milestones |
| `auto.pause_between_milestones` | `false` | Auto runs end-to-end |
| `parallel.enabled` | `true` | Use parallel execution strategies |
| `parallel.max_milestones` | `3` | Max concurrent milestone lanes |
| `parallel.max_stories_per_milestone` | `2` | Max concurrent story lanes |
| `tdd.mode` | `auto` | `auto`, `on`, or `off` |
