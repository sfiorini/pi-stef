# @pi-stef/fh-team

Pi extension that runs a small **team of role-agents** (planner, developer, reviewer, researcher) as `pi` subprocesses to drive plan / implement / task / auto / followup workflows.

Use it for larger code changes where you want a durable plan folder, reviewer-approved milestones, resumable orchestration, configurable verification gates, and optional tmux side panes without asking a single model to hold the entire workflow in memory.

## Contents

- [Tools](#tools)
- [Start A Workflow](#start-a-workflow)
- [Steer Active Workflow](#steer-active-workflow)
- [Resume Interrupted Workflow](#resume-interrupted-workflow)
- [Architecture](#architecture)
- [TDD policy](#tdd-policy)
- [Configuration](#configuration)
- [Quickstart](#quickstart)
- [Running without a git repository](#running-without-a-git-repository)
- [Migration and behavior-change notes](#migration-and-behavior-change-notes)
- [Using Headless Mode](#using-headless-mode)
- [Cost totals](#cost-totals)
- [Performance reports](#performance-reports)
- [tmux integration](#tmux-integration)
- [Safety properties](#safety-properties)
- [Plan-folder layout](#plan-folder-layout)

## Tools

Each base workflow registers TWO Pi tools — `<base>` (start) and
`<base>_resume`. `fh_team_steer` is a standalone ingress tool for
sending instructions to a currently active workflow; it intentionally
has no `_resume` variant. `<base>` accepts a flat single-mode schema (the new
run's required key plus tool-specific knobs); `<base>_resume` requires
`resume` (the slug, absolute path, or relative `ai_plan/<slug>` path)
and accepts the same tool-specific knobs alongside it. There is no
top-level `anyOf` union, so calling LLMs hit the right shape on the
first try and self-correct on a precise per-key validation error
instead of an `anyOf` cascade. See `Schemas per tool` below for the
exact required + optional keys per variant.

| Workflow | Start tool | Resume tool |
| --- | --- | --- |
| Plan only | `fh_team_plan` | `fh_team_plan_resume` |
| Implement an approved plan | `fh_team_implement` | `fh_team_implement_resume` |
| End-to-end single task | `fh_team_task` | `fh_team_task_resume` |
| Plan + implement chained | `fh_team_auto` | `fh_team_auto_resume` |
| Follow-up against a completed plan | `fh_team_followup` | `fh_team_followup_resume` |
| Steer an active workflow | `fh_team_steer` | none |

What each workflow does:

- **plan**: researcher (analyze brief + repo) → Q&A → external-context fetch → planner-draft → reviewer loop → write 5-file plan folder.
- **implement**: read plan folder → optional worktree → strategy-aware milestone/story lanes when safe → reviewer loop → configured verification hook → commit/merge → user-gate (D1) → final pr-description.
- **task**: full end-to-end single-task workflow: plan-review → implement → impl-review → configured verification hook → commit → push decision → pr-description.
- **auto**: chains `fh_team_plan` and `fh_team_implement` (D2 mode), no human gates between.
- **followup**: resolves the parent plan, drafts and implements a follow-up against it as a brand-new sibling plan folder under `ai_plan/<date>-followup-<slug>/`. Runs in the current branch (mirrors `fh_team_task`); the parent's plan folder and pr-description are not modified.
- **steer**: appends a user instruction to the durable steering inbox for an active workflow, targeted by `workflowId`, `planSlug`, or the single unambiguous active workflow. Ambiguous targets return candidate workflow ids instead of guessing.

Slash commands mirror the split: `/fh_team_plan` for new runs and `/fh_team_plan_resume` for resume (and the same shape for the other four workflows). `/fh_team_steer` posts to the standalone steer tool. If Pi is busy, workflow slash commands queue as follow-up instructions, while `/fh_team_steer` is delivered with Pi's steering delivery mode.

During `fh_team_plan` research Q&A, questions are required by default. Selection questions automatically include an `Other (describe)` choice that opens inline text entry and stores the typed text as the answer. Escape does not skip required selection or free-text questions; it only skips a free-text question when the researcher explicitly marked that question optional. Recorded answers are cached in `ai_plan/<slug>/research-answers.json` so resume does not re-ask already answered questions.

### Schemas per tool

Each tool carries a flat single-mode `Type.Object({...}, { additionalProperties: false })` schema (no top-level `anyOf` union). Required keys are bold below; everything else is optional.

| Tool | Required key | Optional keys |
| --- | --- | --- |
| `fh_team_plan` | **`title`** | `brief`, `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_plan_resume` | **`resume`** | `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_implement` | **`slug`** | `mode`, `maxRounds`, `useWorktree`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_implement_resume` | **`resume`** | `mode`, `maxRounds`, `useWorktree`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_task` | **`title`** | `brief`, `maxRounds`, `allowDirty`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_task_resume` | **`resume`** | `maxRounds`, `allowDirty`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_auto` | **`title`** | `brief`, `maxRounds`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_auto_resume` | **`resume`** | `maxRounds`, `branchPrefix`, `pauseBetweenMilestones`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_followup` | **`title`** | `brief`, `parentPlan`, `allowDirty`, `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_followup_resume` | **`resume`** | `parentPlan`, `allowDirty`, `maxRounds`, `verification`, `aiPlanPath`, `gitMode`, `tddMode` |
| `fh_team_steer` | **`instruction`** | `workflowId`, `planSlug`, `priority`, `targetHints`, `aiPlanPath` |

## Start A Workflow

Use natural language when you want the agent to pick the right fh-team workflow for the job:

```text
fh-agent "Use fh_team_auto to plan and implement adding per-org rate limiting. Use Claude Opus as reviewer and stop before pushing."
fh-agent "Use fh_team_task for a small bug fix: reproduce the cache eviction race, add a regression test, fix it, get review, and commit locally."
```

Use exact tool calls when you already know the workflow and inputs. Each workflow has a start tool at the bare base name and a resume tool with a `_resume` suffix:

```text
fh_team_plan title="Add per-org rate limiting" brief="Create a reviewed milestone plan only."
fh_team_implement slug=2026-05-01-add-per-org-rate-limiting
fh_team_auto title="Refactor auth module" brief="Plan, implement, review, verify, and commit locally."
fh_team_task title="Fix race in cache eviction"
fh_team_followup title="Add metric for cache evictions" parentPlan=2026-05-01-cache-eviction
fh_team_steer planSlug=2026-05-01-cache-eviction instruction="Before continuing, make the metric name configurable."
```

Running outside a git repository — pass `gitMode=off` (or let `auto` detect) and optionally supply `aiPlanPath` to put the plan folder wherever you like:

```text
fh_team_plan title="Upgrade Postgres to 17" gitMode=off aiPlanPath=~/research/2026-Q2
fh_team_task title="Audit breaking changes in react-router v7" gitMode=off
fh_team_implement slug=2026-05-01-upgrade-postgres aiPlanPath=~/research/2026-Q2 gitMode=off
fh_team_auto title="Refactor auth module" gitMode=off aiPlanPath=~/work/plans
fh_team_followup title="Add query-plan metric" gitMode=off aiPlanPath=~/research/2026-Q2
fh_team_steer planSlug=2026-05-01-upgrade-postgres aiPlanPath=~/research/2026-Q2 instruction="Skip the vacuum step"
```

## Steer Active Workflow

Use `fh_team_steer` when a workflow is already running and you need to amend its next decision without starting a new run. Target an explicit `workflowId` when the active workflow list is ambiguous, or use `planSlug` when you know the plan folder:

```text
fh_team_steer workflowId=fhw_implement_20260517094530_ab12cd34 instruction="Restart the current developer with the stricter API constraint."
fh_team_steer planSlug=2026-05-01-cache-eviction instruction="Do not touch the public cache interface; adapt internals only."
```

When exactly one fh-team workflow is active, `instruction` alone is accepted. When multiple active workflows match, the tool returns candidate workflow ids and does not append anything.

The active workflow keeps the main orchestrator loop available for conversation while role agents run in the background. Safe-boundary drains run at workflow start, before/after role-agent spawns, during active child ticks, before milestone completion, and before final completion. Each drain asks a steering-decider to classify the new instruction against the current snapshot, then records the decision, snapshots, and actions under `.fh-workflow/steering/`.

Steering can apply future guidance, restart or stop running agents, request confirmation before destructive worktree discard, amend a milestone plan, or mark completed stories/milestones as `needs-rework` so execution resumes from the amended point. Resume reconciles stale active-agent records, requeues orphaned `analyzing` or `partially-applied` instructions, and uses `applied-instructions.jsonl` to avoid replaying decisions that already took effect.

### Trust boundary

Steering text is **advisory, not authoritative**. It comes from the user (via `fh_team_steer` or the slash command) and from the steering-decider model's `guidanceText` field. All consumers treat it as untrusted input: no authorization decisions are made from it, and destructive actions still require the existing confirmation gate.

Persisted shape:
- Raw instruction text persisted to `inbox.jsonl` via `appendInstruction` is length-capped (default 4000 chars) so a runaway pasted payload cannot blow up the durable store.
- `SteeringGuidance` rows persisted to `guidance.jsonl` are additionally sanitized (NUL, zero-width characters, and ASCII control characters except `\n` / `\t` are stripped) and truncated to 2000 chars per row before persistence.

Injection shape:
- Every injected line in the `## Active Steering Guidance` section is prefixed with `[steering <source>:<instructionId>]`. Multi-line guidance has the prefix repeated on every continuation line so an agent reading the section can see provenance on every line.

### apply-to-future strategy

When a steering instruction is classified `apply-to-future`, the decider also emits `scopeKind` (default `workflow`; can narrow to `milestone`, `story`, or `role`) plus a required `guidanceText`. The orchestrator persists a `SteeringGuidance` row to `guidance.jsonl`, marks the instruction `applied`, activates the row, and appends a `## Steering Notes` bullet to `milestone-plan.md` and `final-transcript.md`. Future agent spawns prepend `## Active Steering Guidance` at the top of their prompts (helper-layer injection in `tools/shared.ts:makeSpawnHelper`; runtime/spawn.ts is not modified). Active visibility uses a derived predicate (`guidance.status === "active"` AND `instruction.status === "applied"`) so consumers never read a half-activated row, and resume reconciliation flips orphaned `pending-activation` rows to `active` / `expired` based on the instruction's recovered state. Milestone- and story-scoped rows expire when their scope completes; workflow-scoped rows expire on workflow completion or non-pause abort.

### Multi-instruction strategy

When the drain finds multiple pending instructions, they are sorted urgent-first then by `receivedAt` and submitted to the decider in ONE batched prompt (`{decisions: [...]}` response). Strict batch validation (exact count, every input id present exactly once, no extras) fails the whole batch on mismatch with a shared `batchErrorId`. If all decisions are non-destructive, they apply under a shared snapshot. If any decision is destructive, the non-destructive set applies first; then each destructive instruction triggers a FRESH snapshot + a FRESH per-instruction decider call (preserves the normalize fallback) + the existing confirmation gate. The first `requires-user-confirmation` breaks the destructive loop; remaining destructive instructions are returned to `queued` so the next drain after `clearPause()` reprocesses them.

### Failure-pause behavior

Any failed instruction or `requires-user-confirmation` latches a `SteeringPauseState` on the orchestrator context (persisted to `state.json`). Every safe-boundary check reads it; in interactive mode `enforcePauseAtSafeBoundary` prompts the operator, and in headless mode it throws `PausedSteeringError`. `orchestrator/run.ts` treats `PausedSteeringError` as a third workflow-exit branch alongside completed/aborted: it preserves workflow-scoped guidance and the latch so the next resume can react. The drain's `failInstruction` helper is the single funnel for failure side effects (failed-snapshot write, sanitized raw decider output, audit transcript, guidance expiry, pause latch).

### Steering internals layout

After the M5 split the steering module is organized as:

- `steering/decider/` — `index.ts` (single-instruction + batch decide + validation) and `normalize.ts` (canonical alias table for shorthand decider outputs).
- `steering/drain/` — `index.ts` (drain pipeline, dispatch, audit, failure recording, pause latching).
- `steering/guidance-*.ts` — guidance ledger sanitization, helper-layer injection, plan-note writer + reapply.
- `steering/decider.ts` and `steering/drain.ts` remain at their original paths as thin re-export shims, so external imports of `from ".../steering/decider"` and `from ".../steering/drain"` continue to resolve unchanged.

Cost and context warning: steering may spawn an additional steering-decider role agent and, for plan amendments, planner/revision agents. Frequent steering on long workflows can therefore increase token usage, transcript size, and review latency.

## Resume Interrupted Workflow

If a workflow was interrupted, ask for exact resume and provide the same plan slug or plan-folder path:

```text
fh-agent "Resume the interrupted fh_team_auto workflow from 2026-05-06-refactor-auth and continue from its saved checkpoints."
fh-agent "Resume the fh_team_task workflow at ./ai_plan/2026-05-06-fix-cache-race; do not start a new task."
```

Technical exact-resume calls use the dedicated `_resume` tool with a `resume` input. The target can be a slug, a relative `ai_plan/<slug>` path, or an absolute plan-folder path:

```text
fh_team_plan_resume resume=2026-05-06-add-rate-limit
fh_team_implement_resume resume=./ai_plan/2026-05-06-add-rate-limit
fh_team_task_resume resume=/path/to/repo/ai_plan/2026-05-06-fix-cache-race
fh_team_auto_resume resume=2026-05-06-refactor-auth
fh_team_followup_resume resume=2026-05-08-followup-add-cache-metric
```

The historical `fh_team_<base> resume=...` form (a single tool with an `anyOf` start/resume schema) is gone. Use `<base>_resume` for resume calls. Natural-language phrasing like `fh-agent "Resume the interrupted fh_team_auto workflow ..."` still works because the agent routes through the right tool when interpreting the request.

Exact resume normally requires `.fh-workflow/workflow.json` to prove the same owner tool started the folder. Older metadata-less auto folders can be recovered only when they already contain both plan checkpoints and milestone implementation checkpoints; the resumed run writes metadata for future resumes. After ownership is accepted, `fh_team_auto_resume resume=<target>` skips researcher/planner whenever it finds an existing implementable five-file plan folder and resumes the implementation phase directly.

## Architecture

The TypeScript orchestrator owns the state machine. Each role-agent is a single-job pi subprocess: receive a typed payload, produce content (plan markdown / code changes / verdict markdown), exit. Review loops alternate role-agent spawns and reviewer spawns; agents do not spawn other agents.

Reusable workflow concerns live in `@pi-stef/agent-workflows`: plan-folder locks, `.fh-workflow` metadata, checkpoint stores, resume target analysis, widget messages, verification policy/cache helpers, and the generic `runWorkflow` lifecycle. `fh-team` is the first consumer of that library and keeps the tool-specific pieces: role prompts, plan/tracker parsing, worktree and merge policy, tmux panes, transcripts, diagnostics, performance reports, Telegram notifications, and final result formatting.

Reviewers and the researcher always run with strict isolation: `--no-prompt-templates --no-extensions --no-context-files --tools read,grep,find,ls` (reviewer also pins `--no-skills`). Planner and developer agents get role-tuned skills via `--skill <path>`.

Roles:
- **researcher** — read-only analyzer. `fh_team_plan` runs it first to inspect the brief + repo state and emit a structured findings JSON (clarifying questions, files to touch, risks). Skill-free; no `bash`/`edit`/`write`.
- **planner** — drafts the milestone plan. Receives researcher findings + Q&A answers as context. Skills: `brainstorming`, `writing-plans`.
- **developer** — implements one milestone at a time. Skills: `tdd`, `verification-before-completion`. Bound by the strict TDD contract documented in [TDD policy](#tdd-policy).
- **reviewer** — strict isolation, read-only tools. Verdict format `## Summary` / `## Findings` (P0–P3) / `## Verdict`.

When the configured verification gate fails after impl-review approval (`phase: "after"`), `fh_team_*` tools route the failure back into the same dev/reviewer pair instead of aborting the workflow. `tools/verification-stage.ts` throws a typed `VerificationGateFailure` carrying structured fields (toolName, phase, stageLabel, command, exitCode, signal, stdoutTail, stderrTail). `tools/verification-gate-loop.ts:runVerificationGateWithFixLoop` catches it, calls `synthesizeGateFinding` to build a synthetic `ReviewerVerdict` whose `verdictText` carries a parser-stable single-line summary (referencing the transcript) and whose `findings.P0[0]` carries the full multi-line redacted body the developer sees in their revise brief, then drives `runDeveloperRevise` followed by `runReviewer` for at most `review.implementation_max_rounds - implRound` more rounds. A reviewer-approved fix triggers a re-run of the gate; a reviewer rejection surfaces a `VerificationGateFixUnapprovedError`; budget exhaustion rethrows the most recent typed failure. `phase: "before"` gates retain their direct-throw behavior (a baseline-health failure has no developer fix to drive). Stderr/stdout embedded in the synthesized finding is capped at 4 KB after redaction (auth headers + `KEY=value` env-var patterns), so a long secret-bearing line at the tail can't leak through the cap, and the embedded text is labeled UNTRUSTED diagnostic data so the developer/reviewer treat it as evidence rather than instructions.

## TDD policy

Every `fh_team_*` developer agent (task, followup, implement, auto) is bound by a strict test-first contract; `fh_team_plan` has no developer agent, but its planner brief receives the `PLANNER_TDD_REMINDER` so the plan is laid out tests-first. The contract is centralized in `packages/fh-team/src/tools/tdd-policy.ts` (`composeTddContract`, `REVIEWER_TDD_POLICY`, `PLANNER_TDD_REMINDER`) so prompts cannot drift across tools.

Before writing any non-test code the developer MUST:

1. Write the test(s) that capture the new/changed behavior in a `*.test.ts` (or `*.spec.ts`) file colocated with existing tests for the area being touched.
2. Run them with a TARGETED command (e.g. `pnpm -F <pkg> test path/to/the.test.ts` or `pnpm -F <pkg> test -t "<test-name>"`) and confirm RED — the failure is on the new behavior, not a syntax error or import miss.
3. Implement the change. Stage only the files touched (never `git add -A`).
4. Re-run the same targeted command and confirm GREEN. The orchestrator runs the full configured verification gate (typecheck + test) after impl-review approval; the developer should NOT run the full suite themselves.

The handoff prose to the reviewer MUST contain a `## TDD proof` section with four labeled subsections:

- `### Tests added` — file paths + test names, one line per test.
- `### Red` — verbatim output of step 2 (command + the failure tail).
- `### Implementation` — one-line summary of what changed and why it now satisfies the test.
- `### Green` — verbatim output of step 4 (command + the pass summary line).

When the staged diff is genuinely test-irrelevant (docs, README, `package.json` bumps, type-only signature changes with no runtime branch), the developer may replace the proof block with a single line:

```text
no-test-needed: <one-sentence reason citing why no behavior changed>
```

The reviewer is required to issue a P0 finding (`TDD proof missing` or `unconvincing no-test-needed rationale: <why>`) and `VERDICT: REVISE` when the proof block is missing or the rationale is unconvincing for the staged diff. The reviewer does NOT approve solely because the diff looks correct — without the proof, there is no way to tell whether the developer actually exercised the change.

Planner agents receive a `PLANNER_TDD_REMINDER` that nudges them to schedule each story's test step BEFORE its implementation step, and to flag genuinely test-irrelevant stories with `no-test-needed: <reason>` so the downstream developer agent isn't required to invent a test for a docs-only change.

## Configuration

Layered global + project config, with project winning at field level:

- Global: `~/.pi/fh-team/config.json`
- Project: `<repo>/.fh-team.json`

Resolution chain (locked): `prompt args → project config → global config → DEFAULT_CONFIG`. The first non-`undefined` value wins.

`scripts/fh-agent install fh-team` creates the global file at `~/.pi/fh-team/config.json` when it is missing. Existing files are preserved and reported as pre-existing. Project files are intentionally not generated: `<repo>/.fh-team.json` should contain only sparse overrides that belong in that repository.

The generated file is copied from [`packages/fh-team/config/defaults.json`](config/defaults.json) and includes every built-in default. That includes reserved keys accepted by the schema but not honored yet, and advanced operational keys such as `heartbeatMs`; see the reference table below before changing those.

```jsonc
{
  "agents": {
    "planner": { "model": "claude-sonnet-4-6", "thinking": "medium", "heartbeatMs": 300000 },
    "reviewer": { "model": "claude-sonnet-4-6", "thinking": "high", "heartbeatMs": 600000 },
    "developer": { "model": "claude-sonnet-4-6", "thinking": "medium", "heartbeatMs": 600000 },
    "researcher": { "model": "claude-haiku-4-5", "thinking": "low", "heartbeatMs": 300000 }
  },
  "review": { "max_rounds": 10, "plan_max_rounds": 10, "implementation_max_rounds": 10 },
  "workflow": { "profile": "default" },
  "plan": { "verification": { "timing": "off", "mode": "commands", "stages": ["typecheck", "test"], "cache": { "mode": "run" }, "maxAttempts": 2 } },
  "implement": { "mode": "single-milestone", "use_worktree": true, "create_branch": true, "branch_prefix": "implement/", "pause_between_milestones": true, "verification": { "timing": "after", "mode": "commands", "stages": ["typecheck", "test"], "cache": { "mode": "run" }, "maxAttempts": 2 } },
  "auto": { "mode": "all-milestones", "use_worktree": true, "create_branch": true, "branch_prefix": "auto/", "pause_between_milestones": false, "verification": { "timing": "after", "mode": "commands", "stages": ["typecheck", "test"], "cache": { "mode": "run" }, "maxAttempts": 2 } },
  "task": { "use_worktree": false, "create_branch": false, "allow_dirty": false, "verification": { "timing": "after", "mode": "commands", "stages": ["typecheck", "test"], "cache": { "mode": "run" }, "maxAttempts": 2 } },
  "followup": { "allow_dirty": false, "verification": { "timing": "after", "mode": "commands", "stages": ["typecheck", "test"], "cache": { "mode": "run" }, "maxAttempts": 2 } },
  "notifications": { "telegram": { "enabled": false } },
  "performance": { "widget_update_interval_ms": 150, "researcher": "auto", "plan_revision": "patch" },
  "parallel": { "enabled": true, "max_milestones": 3, "max_stories_per_milestone": 2, "on_conflict": "stop" },
  "steering": { "enabled": true, "max_instruction_chars": 4000, "child_active_tick_ms": 5000 }
}
```

### Resume targets and ownership

Every `fh_team_*_resume` tool accepts a `resume` field. The target can be a plan slug (`2026-05-06-add-rate-limit`), a relative path (`./ai_plan/2026-05-06-add-rate-limit`), or an absolute path to a plan folder. The start (bare `<base>`) and `<base>_resume` variants are mutually exclusive — invoke one or the other, never both.

```text
fh_team_plan_resume resume=2026-05-06-add-rate-limit
fh_team_implement_resume resume=2026-05-06-add-rate-limit
fh_team_task_resume resume=2026-05-06-fix-cache-race
fh_team_auto_resume resume=2026-05-06-refactor-auth
fh_team_followup_resume resume=2026-05-08-followup-add-cache-metric
```

Resume is intentionally strict. The workflow folder records the tool that started the run, and exact resume is allowed only by the matching `_resume` variant of that same workflow:

| Started by | Resumed by |
| --- | --- |
| `fh_team_plan` | `fh_team_plan_resume` |
| `fh_team_implement` | `fh_team_implement_resume` |
| `fh_team_task` | `fh_team_task_resume` |
| `fh_team_auto` | `fh_team_auto_resume` |
| `fh_team_followup` | `fh_team_followup_resume` |

Normal handoff is still supported: `fh_team_implement slug=<slug>` can implement a five-file plan produced by `fh_team_plan`. That is not exact resume; it is the normal plan-to-implementation workflow, and implement intentionally claims plan-owned metadata for that handoff. `fh_team_followup title=... parentPlan=<parent-slug>` still targets a parent plan to derive context from. Exact follow-up resume targets the FOLLOWUP'S OWN slug — `fh_team_followup_resume resume=<followup-slug>` (e.g. `2026-05-08-followup-better-anim`) — and the resume code re-loads the parent's milestone-plan from the followup's `.fh-workflow/workflow.json` `parentSlug`.

Legacy policy:

- If `.fh-workflow/workflow.json` exists, `ownerTool` must match the invoked tool's workflow base (`fh_team_plan_resume` matches an `fh_team_plan` owner record, etc.).
- If metadata is missing, `fh_team_implement_resume resume=<slug-or-path>` may resume a legacy five-file plan folder.
- If metadata is missing, `fh_team_auto_resume resume=<slug-or-path>` may resume only a five-file plan folder that already has both plan-phase checkpoints and milestone implementation checkpoints. This evidence is used for legacy ownership recovery; once accepted, auto resumes implementation directly instead of rerunning the plan phase. The resumed run writes `workflow.json` so later resumes use the normal owner check.
- Other exact resume calls require metadata because they cannot reconstruct planner/task/follow-up subprocess boundaries safely.
- A completed checkpoint is reused only when its input fingerprint still matches. The current failed or in-progress step runs again.

`fh_team_auto` (and its `_resume` companion) owns the whole chained workflow even though it runs nested `fh_team_plan` and `fh_team_implement` phases. Metadata records `ownerTool: "fh_team_auto"` and updates `currentTool` as each inner phase runs. Between phases, status may briefly be `completed` before the next phase reopens the same owner record as `running`. If `fh_team_auto_resume` starts after the plan folder exists, it does not rerun researcher or planner; it calls implement with `resume` so completed checkpoints are reused and the current in-progress milestone reruns.

On resume, worktree safety stays conservative. The expected worktree must be attached to the expected branch and not diverged. Explicit resume may reuse that attached worktree even when it contains interrupted edits, because those edits are the state being resumed. Fresh runs still reject dirty attached worktrees, and deleted, divergent, or ambiguous branches abort with a diagnostic instead of being cleaned up automatically.

### Widget messages

Short workflow notices render in the main widget after the header/resume banner and before the milestone strip. This keeps transient status lines such as dependency-install notices, verification skips, retries, and cache hits out of the chat transcript.

Message behavior:

- Latest five messages are kept.
- Text is shortened to 140 characters.
- Info messages expire after 8 seconds.
- Warning messages expire after 15 seconds.
- Error messages stay until explicitly cleared unless a TTL is supplied.
- Timers are cleared when the orchestrator exits.
- Without a mounted widget, warnings/errors fall back to stderr; info messages are printed only with `FH_AGENT_WORKFLOW_VERBOSE=1`.

### Verification policy

Verification is configured per tool under `plan.verification`, `implement.verification`, `auto.verification`, `task.verification`, and `followup.verification`. Tool-call `verification` input overrides the resolved config for that run. Legacy `verifyCommand` still works for implement/task/auto/followup and maps to one custom after-command; `verifyCommand=false` maps to `timing: "off"`.

The workflows expose before/after verification hook points, but the resolved verification policy decides whether each hook does work. `timing: "off"` disables verification, `timing: "before"` uses only the before hook, `timing: "after"` uses only the after hook, and `timing: "both"` uses both. The default after hook for implement/task/followup is placed after impl-review convergence so review fixes do not repeatedly trigger full test/typecheck/lint runs.

Defaults:

| Tool config | Default timing | Default mode | Default stages | Default cache |
| --- | --- | --- | --- | --- |
| `plan.verification` | `off` | `commands` | `typecheck`, `test` | `run` |
| `implement.verification` | `after` | `commands` | `typecheck`, `test` | `run` |
| `auto.verification` | `after` | `commands` | `typecheck`, `test` | `run` |
| `task.verification` | `after` | `commands` | `typecheck`, `test` | `run` |
| `followup.verification` | `after` | `commands` | `typecheck`, `test` | `run` |

`fh_team_auto` suppresses `plan.verification` during its nested plan phase so the chain does not verify before any implementation exists. Its implement phase uses `auto.verification`, not `implement.verification`.

Accepted verification keys:

| Key | Values |
| --- | --- |
| `timing` | `off`, `before`, `after`, `both` |
| `mode` | `commands`, `agent`, `commands-and-agent` |
| `stages` | `typecheck`, `test`, `lint`, `all`, a custom command object, or an array of those |
| `commands` | one custom command object or an array of command objects |
| `cache` | `off`, `run`, `persistent`, or `{ "mode": "...", "path": "..." }` |
| `maxAttempts` / `max_attempts` | integer retry count, 1-10 |

Custom command object:

```jsonc
{ "label": "unit smoke", "cmd": "pnpm", "args": ["test", "--", "tests/smoke.test.ts"] }
```

Examples:

```jsonc
{
  "implement": {
    "verification": {
      "timing": "both",
      "mode": "commands",
      "stages": ["typecheck", "test", "lint"],
      "cache": { "mode": "run" },
      "maxAttempts": 2
    }
  },
  "task": {
    "verification": {
      "timing": "after",
      "mode": "commands-and-agent",
      "stages": "all",
      "commands": [
        { "label": "catalog check", "cmd": "pnpm", "args": ["catalog:check"] }
      ],
      "cache": "persistent"
    }
  },
  "auto": {
    "verification": {
      "timing": "after",
      "mode": "commands",
      "stages": ["typecheck", "test"]
    }
  }
}
```

Named stages resolve to package scripts in the verification cwd. Missing scripts are skipped with a widget message rather than treated as a passing command. `mode: "agent"` or `mode: "commands-and-agent"` spawns a read-only verifier agent using the reviewer role settings; the verifier must return exactly one `VERIFICATION: PASS` status line or the gate fails.

The run cache avoids repeating a command within one orchestrator run when the verification fingerprint is unchanged. The fingerprint includes cwd, tool name, phase, command, package-manager files/install state, git `HEAD`, git status, unstaged diff, staged diff, and untracked file contents. Persistent cache is opt-in and defaults to `ai_plan/<slug>/.fh-workflow/verification-cache.json`; unreadable, invalid, or missing cache files are treated as misses.

### Model ids: prefer `provider/model`

`pi` resolves bare model ids by scanning all registered providers and may pick one you have not authenticated. If you see `No API key found for <provider>` immediately on agent start, qualify the model with its provider:

```jsonc
{
  "agents": {
    "planner":    { "model": "openai-codex/gpt-5.3-codex", "thinking": "medium" },
    "reviewer":   { "model": "openai-codex/gpt-5.2",       "thinking": "low" },
    "developer":  { "model": "claude-haiku-4-5",           "thinking": "medium" },
    "researcher": { "model": "openai-codex/gpt-5.4-mini",  "thinking": "medium" }
  }
}
```

Anthropic ids are unambiguous (only `anthropic` registers them), so `claude-*` works without a prefix. Run `pi --list-models` to see the full provider/model table for your install.

Broken JSON or schema violations in either file are surfaced via `ui.notify` (paths sanitized to `~/...` or `<repo>/...`) and the run falls back to built-in defaults — your config is not silently ignored.

### Speed and rollback examples

Quality-first rollback to the prior Opus-heavy behavior:

```jsonc
{
  "agents": {
    "planner":    { "model": "claude-opus-4-7", "thinking": "high",   "heartbeatMs": 300000 },
    "reviewer":   { "model": "claude-opus-4-7", "thinking": "xhigh",  "heartbeatMs": 600000 },
    "developer":  { "model": "claude-opus-4-7", "thinking": "high",   "heartbeatMs": 600000 },
    "researcher": { "model": "claude-opus-4-7", "thinking": "medium", "heartbeatMs": 300000 }
  },
  "performance": { "researcher": "always", "plan_revision": "full" }
}
```

Explicit faster/lower-cost example:

```jsonc
{
  "agents": {
    "planner":    { "model": "claude-haiku-4-5", "thinking": "low" },
    "reviewer":   { "model": "claude-sonnet-4-6", "thinking": "medium" },
    "developer":  { "model": "claude-sonnet-4-6", "thinking": "low" },
    "researcher": { "model": "claude-haiku-4-5", "thinking": "low" }
  },
  "performance": { "researcher": "auto" }
}
```

Cursor/OpenAI role mix example:

```jsonc
{
  "agents": {
    "researcher": { "model": "cursor/composer-2", "thinking": "high" },
    "planner":    { "model": "cursor/gpt-5.3-codex-spark-preview", "thinking": "high" },
    "reviewer":   { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "developer":  { "model": "cursor/claude-4.6-sonnet-thinking", "thinking": "high" }
  }
}
```

Cursor examples require the `cursor-provider` extension. Run `pi --list-models cursor` before copying examples across machines if your provider table differs.

Headless speed profile:

```jsonc
{
  "workflow": { "profile": "headless" }
}
```

The headless profile disables interactive UI side channels for the workflow run, disables tmux pane mirroring, and applies faster review defaults unless explicitly overridden: `review.plan_max_rounds=3`, `review.implementation_max_rounds=4`, and `review.max_rounds=4`.

Override the review budget explicitly when a run needs a different bound:

```jsonc
{
  "workflow": { "profile": "headless" },
  "review": { "plan_max_rounds": 2, "implementation_max_rounds": 5 }
}
```

Run `pi --list-models` before copying examples across machines if your provider table differs.

### Worktree dependency-install fast path

`fh_team_implement`, `fh_team_auto`, and follow-up worktrees install dependencies only when a worktree has a `package.json` and no `node_modules`. Reused parallel lane worktrees keep the cheap path: if `node_modules` is already present, the installer exits immediately.

For repos where dependencies are already available through another mechanism, set this before running the workflow:

```bash
export FH_TEAM_SKIP_AUTO_INSTALL=1
```

This skips automatic installs in newly created worktrees. Use it only when verification commands can still find the required package-manager binaries and dependencies.

### Researcher policy

`performance.researcher` is config-only and accepts:

- `always` — run the researcher before planning.
- `never` — skip the researcher and plan directly from the brief.
- `auto` — skip only when `scanRefs(...)` finds no external refs and the brief has a strong self-contained signal.

`scanRefs(...)` treats URLs, Atlassian Confluence URLs, and Jira-style issue keys as external refs. Local file paths are NOT treated as external refs — the researcher subprocess has `--tools read,grep,find,ls` and reads files directly from the repo without orchestrator-side pre-fetching. Auto-skip phrases are case-insensitive whole-phrase matches: `no research needed`, `skip researcher`, and `use brief as-is`. Other self-contained signals include code blocks, explicit acceptance criteria, and bare file names such as `README.md`.

Full Jira browse URLs may still be detected as URL refs. When the Atlassian Jira context walker successfully fetches the same key, equivalent `/browse/<KEY>` URLs are treated as already covered before researcher Q&A. With `performance.researcher="always"`, the researcher still runs with the fetched ticket context, but it should not ask for already-fetched ticket content. Non-Jira URLs and Confluence URLs without explicit coverage keep the normal unresolved-ref fallback behavior.

### Plan revision mode

`performance.plan_revision` is config-only and accepts:

- `patch` — ask the planner for a small hierarchical JSON patch during plan-review revisions. TypeScript applies the patch to the prior full markdown plan, records patch metrics, and sends the resulting full plan to the reviewer.
- `full` — use the prior behavior: ask the planner to return the complete revised markdown plan.

Patch mode supports top-level sections, milestone IDs, milestone subsections, story IDs, and exact anchored replacements. If the planner returns invalid JSON, targets a missing or ambiguous section, repeats an anchor, or produces no change, fh-team records a fallback transcript entry and runs one full-plan rewrite for that revision. The final files written to `ai_plan/<slug>/` remain complete markdown documents in both modes.

### Execution strategy and parallel limits

New plan folders include `execution-strategy.json`. It declares milestone waves, story waves, dependencies, max parallel caps, and per-story `writeSets`. `fh_team_implement` and `fh_team_auto` use it only when `use_worktree=true`, `parallel.enabled=true`, and the strategy validates. Old plan folders without the artifact use the existing sequential path.

Default parallel config:

```jsonc
{
  "parallel": {
    "enabled": true,
    "max_milestones": 3,
    "max_stories_per_milestone": 2,
    "on_conflict": "stop",
    "keep_lane_branches": false
  }
}
```

Disable parallel execution:

```jsonc
{ "parallel": { "enabled": false } }
```

Lower concurrency while still honoring strategy order:

```jsonc
{
  "parallel": {
    "max_milestones": 1,
    "max_stories_per_milestone": 1
  }
}
```

Safety behavior:

- Each parallel story and milestone lane gets its own git worktree and branch; no two developers share one index.
- Story lanes commit locally, then merge into the milestone lane in story order after the wave settles.
- Approved milestone lanes merge into the aggregate implementation branch in strategy order.
- Merge conflicts run `git merge --abort`, write diagnostics under the plan folder, and stop. fh-team does not overwrite conflicted work.
- In `single-milestone` mode, pending milestones stay in strategy order but are scheduled one milestone batch at a time so the inter-milestone gate can stop before the next milestone. Interactive implement runs pause by default after each approved milestone; headless runs continue with a warning.
- `all-milestones` preserves the execution strategy's milestone waves and runs them through unless a configured pause gate stops the run.

### Failure-mode guarantees

Every fh-team tool throws a typed `FhTeamToolError` (or one of its
subclasses: `EmptyDiffError`, `EmptyPlanError`, `MergeFailedError`,
`WorkflowStateError`, `ConfigLoadError`, `LaneCleanupError`) on
failure. The Pi runtime surfaces a thrown error to the calling LLM by
setting `isError: true` and using `error.message` verbatim as the tool
result text — typed-error fields do NOT survive that boundary, so
`Error.message` itself carries the full payload:

```text
FAILED: <toolName> <kind>: <description>. RESUME: <recovery instruction>.
```

Any non-typed exception thrown inside an `execute()` body is normalized
by the boundary helper `wrapExecute(<piToolName>, ...)` into
`FAILED: <toolName> internal: <stringifiedCause>. RESUME: invoke
<base>_resume { resume: '<slug-or-path>' } to retry from saved state, or
consult the fh-team transcript under ai_plan/<slug>/ for details`. The
`<base>_resume` recommendation is only included when `<piToolName>` is a
recognized fh-team workflow; for unknown tool names the hint falls back
to the transcript-only line. So calling LLMs always see a structured
failure envelope with a clear next step — they can never
misread an empty-diff or merge failure as silent success and pivot to
something unrelated.

### Empty-diff recovery

When the developer agent stages no changes (`git diff --cached` is
empty), the implement tool re-prompts the developer up to
`implement.empty_diff_retries` times (default 2). The reprompt names the
milestone (or story for the parallel-story site) and asks unambiguously
for staged changes via Edit/Write, and each retry's developer output is
recorded to the transcript under
`developer-impl-retry-<milestone-id>(-<story-id>)?-<attempt>`.

If the run is still empty after the budget is exhausted, the tool
throws an `EmptyDiffError`:

```text
FAILED: fh_team_implement empty_diff: milestone M5 produced no
changes after 3 attempts. RESUME: invoke fh_team_implement_resume
{ resume: '<slug>' } and consider setting
`implement.empty_diff_retry_model` to a stronger model in
~/.pi/fh-team/config.json.
```

Two config knobs control retry policy:

```jsonc
{
  "implement": {
    "empty_diff_retries": 2,                    // 0 disables retries
    "empty_diff_retry_model": "claude-opus-4-7" // optional; if set, only the LAST retry uses it
  }
}
```

Both knobs also exist on the `auto` section (mapped onto the implement
phase when `fh_team_auto` calls `fh_team_implement`
internally). The model bump is opt-in to keep token spend bounded; when
unset (default), every retry uses the configured developer model.

When a retry succeeds, the held `developerOutput` is replaced so the
impl-review reviewer payload reflects the recovered run's text rather
than the empty first attempt.

### Lane branch cleanup

After a successful parallel rollup, fh-team deletes the lane branch
that was just merged. Four guards run before any destructive
`git branch -d/-D`:

1. Branch name validation (the same `validateWorktreeBranchName`
   validator that lane creation uses; rejects shell-meta, dot-segments,
   leading/trailing slash, empty parts).
2. `git show-ref --verify --quiet refs/heads/<branch>` — branch exists.
3. `git show-ref --hash --verify refs/heads/<branch>` — current tip
   matches the `expectedSha` captured at lane completion (no concurrent
   worktree advanced the tip).
4. `git merge-base --is-ancestor <expectedSha> <mergeTarget>` — the
   lane commit was already merged. `mergeTarget` is `aggregateBranch`
   for milestone lanes and the parent milestone branch for story lanes
   (story lanes merge into the milestone first; only later does the
   milestone merge into aggregate).

Then `git branch -d -- <branch>`. If git rejects with `not fully merged`
*and* all four guards passed, the helper retries with `-D --` (safe:
the merge demonstrably already happened).

Failures NEVER throw — every non-success outcome appends a
`BranchCleanupWarning` to `FhTeamImplementResult.warnings`:

| `kind` | When |
| --- | --- |
| `lane_branch_kept` | `git branch -d/-D` itself failed (e.g. another worktree still holds the branch). |
| `lane_branch_already_deleted` | The branch was gone before cleanup ran. |
| `lane_branch_invalid_name` | `validateWorktreeBranchName` rejected the lane name. No git command was invoked. |
| `lane_branch_ref_moved` | Tip no longer matches `expectedSha`. |
| `lane_branch_not_ancestor` | Lane commit is not an ancestor of `mergeTarget`. |

`register.ts` mentions the warnings count in the result text so callers
see that teardown noticed something even when the run otherwise
succeeded.

To keep lane branches around for debugging:

```jsonc
{ "parallel": { "keep_lane_branches": true } }
```

When that flag is true, the cleanup call is skipped entirely; opt-in
retention does NOT add a warning.

### Streaming diagnostics and event compaction

The raw tmux pane log still receives every stdout/stderr byte from each role agent. In memory, `AgentRun.events` is diagnostic-oriented and compacted for bursty text/thinking streams: retained lifecycle/tool/runtime events are capped, while `eventSummary` carries text/thinking delta counts and `eventsCompacted` tells consumers that the raw stream lives in the pane log. Diagnostics include timing metrics for spawn, first output, first text/tool activity, `agent_end`, process close, and raw-log finish.

Use this synthetic check to verify local stream overhead without calling real models:

```bash
pnpm test -- --run packages/fh-team/tests/spawn-stream-throughput.test.ts packages/fh-team/tests/tui-stream-throttle.test.ts
```

### Reserved fields

- `implement.create_branch`, `task.create_branch` — accepted by the schema but **not yet honored by `createWorktree`**. Setting them has no effect today.
- `task.use_worktree` — accepted by the schema but **`fh_team_task` always edits the current working tree**. The flag is reserved for a future task-isolation feature.

### Inter-milestone pause (`pause_between_milestones`)

Both `implement.*` and `auto.*` accept `pause_between_milestones` (boolean). When `true`, after each milestone is approved + committed, the orchestrator calls `ctx.ui.confirm("Continue to next milestone?", "Milestone <id> approved and committed. Proceed?")` and only continues on a `true` response. When `false`, the loop runs end-to-end without prompting.

| Tool | Default | Rationale |
|------|---------|-----------|
| `implement` | `true` | Single-milestone interactive mode is the safe default for the implement tool — the user generally wants a chance to inspect a milestone's diff before committing the next one. |
| `auto` | `false` | The auto tool's purpose is end-to-end execution; pausing every milestone defeats the value. Set to `true` explicitly when you want the auto run to stop between milestones. |

Resolution: prompt arg → project config → global config → DEFAULT (above). Examples:

```jsonc
// Project-level: make auto pause between milestones
{ "auto": { "pause_between_milestones": true } }

// Project-level: make implement run end-to-end
{ "implement": { "pause_between_milestones": false } }
```

Headless behavior: when `pause_between_milestones=true` is resolved but no UI is available (`!ctx.ui`), a single `console.warn("[fh-team] pause_between_milestones=true but no UI; treating as false")` fires and the loop continues. Tests and CI runs cannot hang on a `confirm` that never gets answered.

The `shouldContinue` callback on `FhTeamImplementInput` is a TEST-ONLY override: production tool registration does NOT inject one. When a test passes `shouldContinue` explicitly, it takes precedence over the config knob (callback semantics are stronger than config). The gate is also skipped after the LAST milestone — there is nothing to continue to.

## Quickstart

```bash
# Install
scripts/fh-agent install fh-team --scope project

# In a pi session, ask the researcher → planner → reviewer pipeline to draft a plan:
fh_team_plan title="Add per-org rate limiting" brief="..."

# Implement the plan in milestone-by-milestone D1 mode:
fh_team_implement slug=2026-05-01-add-per-org-rate-limiting

# Or chain plan + implement autonomously:
fh_team_auto title="Refactor auth module"

# Single-task end-to-end (plan + implement in one shot, writes a task-plan.md but no 5-file milestone folder):
fh_team_task title="Fix race in cache eviction"

# Add a follow-up to a completed plan folder:
fh_team_followup title="Add metric for cache evictions"

# Resume an interrupted exact workflow by slug or plan-folder path:
fh_team_auto_resume resume=2026-05-06-refactor-auth
```

## Running without a git repository

By default, fh-team auto-detects whether the current working directory is inside a git work tree and enables git operations when it is (`gitMode: 'auto'`). When auto-detect finds no git repo, or when you explicitly pass `gitMode='off'`, all git-specific steps are skipped:

- No baseline snapshot, no worktree creation, no commits, no pr-description.
- The developer agent receives plain edit-and-write instructions instead of staging instructions.
- Plan folders and artifact files are written to disk exactly as in git mode; only the commit lifecycle is absent.

### Opting out of git operations

Pass `gitMode='off'` on any tool call, or set it globally via config:

```jsonc
// ~/.pi/fh-team/config.json
{
  "paths": { "git_mode": "off" }
}
```

### Custom plan-folder location

By default, plan folders are written to `<repo>/ai_plan/<slug>/`. Pass `aiPlanPath` to put them anywhere:

```text
fh_team_plan title="Upgrade Postgres to 17" aiPlanPath=/home/user/notes/plans gitMode=off
fh_team_task title="Audit breaking changes" aiPlanPath=~/research/2026-Q2 gitMode=off
fh_team_implement slug=2026-05-01-upgrade-postgres aiPlanPath=/home/user/notes/plans
fh_team_auto title="Refactor auth module" aiPlanPath=~/work/plans
fh_team_followup title="Add metric for cache evictions" aiPlanPath=~/work/plans gitMode=off
fh_team_steer planSlug=2026-05-01-upgrade-postgres aiPlanPath=/home/user/notes/plans instruction="Skip the vacuum step"
```

`aiPlanPath` is resolved to an absolute path and persisted in `.fh-workflow/workflow.json` so `_resume` calls find the folder even when invoked from a different working directory. A global slug-to-planRoot index at `~/.fh-team/plan-index.json` is updated on every plan write; slug-only resumes consult the index when the slug is not found at the default `ai_plan/` location.

### TDD mode

`tddMode` controls the test-driven-development policy independently of `gitMode`:

| `tddMode` | Behavior |
| --- | --- |
| `auto` (default) | TDD proof block required for code changes; `no-test-needed:` shortcut allowed for non-code diffs (docs, config, type-only). |
| `on` | TDD strictly required. `no-test-needed:` shortcut forbidden. Every change must have an accompanying test. |
| `off` | TDD contract waived entirely. No proof block required. |

Set globally via config (`tdd.mode`) or pass per call:

```text
fh_team_task title="Fix race in cache eviction" tddMode=on gitMode=off
```

## Migration and behavior-change notes

All new arguments (`aiPlanPath`, `gitMode`, `tddMode`) are **opt-in**. Existing workflows that do not pass these arguments continue to behave exactly as before:

- `gitMode` defaults to `auto`, which resolves to `on` inside any git work tree — identical to the hard-wired behavior before this release.
- `tddMode` defaults to `auto`, which preserves the prior behavior: TDD proof block required for code changes; the `no-test-needed:` shortcut is allowed for non-code diffs (docs, config, type-only).
- `aiPlanPath` defaults to `undefined`, which resolves to `<cwd>/ai_plan/` — the same path fh-team has always used.

No existing config keys were renamed or removed. The two new config sections (`paths` and `tdd`) are silently ignored by older versions of fh-team, so a shared `~/.pi/fh-team/config.json` that adds these keys is safe to roll out without updating every environment at once.

The only observable change to git-mode workflows is that the developer agent's git/staging instructions are now composed at spawn time via `composeDeveloperSystemPreamble` instead of being hard-coded in `developer.yaml`. The wording is identical; no behavior difference.

## Using Headless Mode

Use headless mode when you want the workflow to spend less time maintaining interactive side channels and more time running the actual phase work. It is intended for fast local runs, CI-like runs, or performance investigations where the performance report is the main artifact.

Enable it per repo in `<repo>/.fh-team.json`:

```jsonc
{
  "workflow": { "profile": "headless" }
}
```

Or enable it globally in `~/.pi/fh-team/config.json`:

```jsonc
{
  "workflow": { "profile": "headless" }
}
```

Then run the normal tools; no separate command is required:

```bash
fh_team_plan title="Add account export flow" brief="..."
fh_team_implement slug=2026-05-06-add-account-export-flow
fh_team_auto title="Refactor notification settings" brief="..."
```

Headless mode changes workflow behavior in three ways:

- It suppresses interactive UI prompts for the workflow run.
- It disables tmux pane mirroring for role-agent output.
- It applies faster review defaults: `review.plan_max_rounds=3`, `review.implementation_max_rounds=4`, and `review.max_rounds=4`.

Explicit prompt/tool arguments still win. For example, passing `maxRounds` on a tool call overrides both phase-specific caps for that call.

Tune the headless review budget when a run needs a different balance:

```jsonc
{
  "workflow": { "profile": "headless" },
  "review": {
    "plan_max_rounds": 2,
    "implementation_max_rounds": 5
  }
}
```

For performance analysis, inspect the report printed by the tool result:

```text
ai_plan/<slug>/reports/performance-<timestamp>.md
```

Use the report's wall time, phase totals, role totals, and failure section to decide where the workflow is spending time. If a review loop hits the configured cap, the run fails closed and the report records that max-round outcome; it does not auto-approve.

### Configuration reference (every key in `ResolvedDefaults`)

| Key | Default | Scope | Description |
|-----|---------|-------|-------------|
| `agents.planner.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `medium`, `300_000` | global+project+prompt | Planner subprocess runtime. |
| `agents.reviewer.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `high`, `600_000` | global+project+prompt | Reviewer subprocess runtime. |
| `agents.developer.{model,thinking,heartbeatMs}` | `claude-sonnet-4-6`, `medium`, `600_000` | global+project+prompt | Developer subprocess runtime. |
| `agents.researcher.{model,thinking,heartbeatMs}` | `claude-haiku-4-5`, `low`, `300_000` | global+project+prompt | Researcher (read-only) subprocess. |
| `workflow.profile` | `default` | global+project | `default` keeps the normal interactive side channels; `headless` disables workflow UI/panes and applies faster review defaults. |
| `review.max_rounds` | `10` (`4` in headless) | global+project+prompt | Compatibility fallback for both review-loop types when the phase-specific cap is not set. |
| `review.plan_max_rounds` | `10` (`3` in headless) | global+project+prompt | Cap on planner ↔ reviewer loops. Prompt `maxRounds` still overrides it for that call. |
| `review.implementation_max_rounds` | `10` (`4` in headless) | global+project+prompt | Cap on developer ↔ reviewer loops. Prompt `maxRounds` still overrides it for that call. |
| `plan.verification` | `{ timing: "off", mode: "commands", stages: ["typecheck","test"], cache: { mode: "run" }, maxAttempts: 2 }` | global+project+prompt | Verification policy for standalone `fh_team_plan`; auto suppresses this during its nested plan phase. |
| `implement.mode` | `single-milestone` | global+project+prompt | `single-milestone` (one developer per M) or `all-milestones` (one developer over all). |
| `implement.use_worktree` | `true` | global+project+prompt | Create a git worktree before implement. False edits the user's tree (baseline captured). |
| `implement.create_branch` | `true` | RESERVED | Reserved for `createWorktree` follow-up — not honored today. |
| `implement.branch_prefix` | `implement/` | global+project+prompt | Branch-name prefix for the worktree. |
| `implement.pause_between_milestones` | `true` | global+project+prompt | Pause + ask `ctx.ui.confirm(...)` between milestones; see "Inter-milestone pause" above. |
| `implement.verification` | `{ timing: "after", mode: "commands", stages: ["typecheck","test"], cache: { mode: "run" }, maxAttempts: 2 }` | global+project+prompt | Verification policy for `fh_team_implement`. |
| `auto.{mode,use_worktree,create_branch,branch_prefix}` | `all-milestones`, `true`, `true`, `auto/` | global+project+prompt | Same shape as `implement.*` but for `fh_team_auto`. |
| `auto.pause_between_milestones` | `false` | global+project+prompt | Defaults to `false` — auto runs end-to-end unless explicitly opted in. |
| `auto.verification` | `{ timing: "after", mode: "commands", stages: ["typecheck","test"], cache: { mode: "run" }, maxAttempts: 2 }` | global+project+prompt | Verification policy used by auto's nested implement phase; it overrides `implement.verification` for auto runs. |
| `task.use_worktree` | `false` | RESERVED | `fh_team_task` always edits the working tree today. |
| `task.create_branch` | `false` | RESERVED | Reserved. |
| `task.allow_dirty` | `false` | global+project+prompt | When false, `fh_team_task` refuses to start with a dirty index. |
| `task.verification` | `{ timing: "after", mode: "commands", stages: ["typecheck","test"], cache: { mode: "run" }, maxAttempts: 2 }` | global+project+prompt | Verification policy for `fh_team_task`. |
| `followup.allow_dirty` | `false` | global+project+prompt | Same dirty-tree guard as task. |
| `followup.verification` | `{ timing: "after", mode: "commands", stages: ["typecheck","test"], cache: { mode: "run" }, maxAttempts: 2 }` | global+project+prompt | Verification policy for `fh_team_followup`. |
| `notifications.telegram.enabled` | `false` | global+project | Send a Telegram summary on terminal outcomes. Honored when both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. |
| `performance.widget_update_interval_ms` | `150` | global+project | Coalesce non-terminal widget renders during bursty agent streams. Valid range: `0`-`5000`; set `0` to render every widget-affecting event immediately. |
| `performance.researcher` | `auto` | global+project | Researcher policy: `auto`, `always`, or `never`. Tool-call parameters do not override it in v1. |
| `performance.plan_revision` | `patch` | global+project | Plan revision strategy. `patch` applies hierarchical JSON patches with full-rewrite fallback; set `full` to force prior full-rewrite behavior. |
| `parallel.enabled` | `true` | global+project | Use validated execution strategies for isolated parallel lanes when `use_worktree=true`; set `false` for the legacy sequential path. |
| `parallel.max_milestones` | `3` | global+project | Upper cap for concurrently running milestone lanes. Strategy caps are clamped by this value. |
| `parallel.max_stories_per_milestone` | `2` | global+project | Upper cap for concurrent story lanes inside one milestone. Strategy caps are clamped by this value. |
| `parallel.on_conflict` | `stop` | global+project | Conflict policy. A failed merge aborts the merge and stops affected execution with diagnostics. |
| `paths.ai_plan_root` | `undefined` (resolves to `<cwd>/ai_plan/`) | global+project+prompt (`aiPlanPath`) | Parent directory for plan folders. Absolute or relative. When set, `<aiPlanPath>/<slug>/` replaces the default `<cwd>/ai_plan/<slug>/`. |
| `paths.git_mode` | `auto` | global+project+prompt (`gitMode`) | `auto` enables git operations when cwd is inside a git work tree; `on` always enables; `off` always disables. |
| `tdd.mode` | `auto` | global+project+prompt (`tddMode`) | TDD policy: `auto` requires a proof block for code changes but allows `no-test-needed:` for non-code diffs; `on` always requires proof (no shortcut); `off` waives the contract entirely. |

Resolution order applies to every knob: `prompt args → <repo>/.fh-team.json → ~/.pi/fh-team/config.json → built-in DEFAULT_CONFIG`. The first non-`undefined` value wins.

## Cost totals

During an interactive `fh_team_*` run, fh-team owns Pi's footer and shows the collected role-agent cost while the subprocesses run. The footer total includes completed agent usage plus any in-flight agent usage Pi has already emitted for the active logical tool run. If a provider has not emitted usage or cost yet, fh-team leaves the footer pending/unavailable rather than estimating.

When provider usage includes cost, the final tool text appends a sentence such as `Your total cost is $10.58.`. If some agents reported cost and others did not, the final sentence uses `at least` wording; if no cost is known, the sentence is omitted.

The registered tool descriptions also instruct the outer assistant to repeat a known cost in its final user-facing summary as `Total cost: $<amount>`; for example, `Total cost: $10.58`.

Resume totals include prior completed performance reports for the same workflow owner plus the active resume invocation. Normal handoff is separate from exact resume: `fh_team_implement slug=<plan-slug>` after a standalone `fh_team_plan` does not include the plan cost, while `fh_team_auto` and `fh_team_auto_resume` treat the nested plan and implement phases as one auto-owned run and count each phase once.

While fh-team owns the footer, Pi's default parent-session footer is hidden unless Pi exposes parent-session usage to the extension, in which case fh-team renders it as a second line. Footer ownership is a single UI slot today: two concurrent fh-team tool invocations in the same Pi UI are last-writer-wins for the live footer, but each run still writes its own final summary and performance report.

Legacy metadata-less auto resumes may overestimate by including old plan and implement reports with the same slug. New performance reports write owner metadata so future resume cost parsing can scope totals to the correct workflow owner.

## Performance reports

Successful and failed workflow runs write `ai_plan/<slug>/reports/performance-<timestamp>.md`. The report includes wall time, workflow profile, review-round limits, per-agent timing, phase totals (`research`, `planning`, `implementation`, `review`), role totals, token/cost totals, owner metadata, and failure details. Cost metadata distinguishes the current run cost, any prior resume baseline, and the total cost including resumed history; unavailable provider cost is reported as unavailable rather than guessed. When a review loop exhausts its configured cap, the report records the failure outcome and diagnostics point back to the performance report path.

New runs also write `performance-<timestamp>.json` beside the markdown report with low-cardinality owner and cost metadata. Resume cost parsing prefers this sidecar and falls back to legacy markdown reports when needed.

For exact resume, prior-cost baselines are scoped by workflow owner. Plan, implement, task, and followup resumes include only their own prior reports. Auto resumes include auto-owned reports; legacy auto folders without owner metadata can also include old plan/implement reports under the same slug as a compatibility fallback.

## tmux integration

Each agent (planner / reviewer / developer / researcher) can mirror its **raw stdout/stderr** into a per-agent tmux pane on the right side of the active session. Panes auto-open on subscribe and auto-close when the agent reaches any terminal state (`completed` / `failed` / `aborted` / `stalled`).

Strategy-aware runs use grouped panes: milestone and reviewer lanes open as horizontal siblings, and story lanes for the same milestone stack vertically inside that milestone group.

Layout (ASCII):

```
+--------------------------------------+------------------------------+
|                                      | planner > running ...        |
|   pi conversation (your interactive  |------------------------------|
|   prompt)                            | reviewer > running ...       |
|                                      |------------------------------|
|                                      | developer > running ...      |
+--------------------------------------+------------------------------+
        <main pane: widget + chat>            <fh-team-side:
                                               per-agent tail panes
                                               stack vertically>
```

Pane content is rendered through `packages/fh-team/scripts/pretty-pane.mjs`. The default theme is `codex`, which groups command/tool output, muted logs, and diff-like lines into a transcript-style view. Overrides:

```bash
FH_TEAM_PANE_THEME=plain fh-agent
PRETTY_PANE_THEME=plain fh-agent
PRETTY_PANE_COLOR=never fh-agent
NO_COLOR=1 fh-agent
```

`FH_TEAM_PANE_THEME` and `PRETTY_PANE_THEME` accept `codex` or `plain`; `plain` preserves the legacy renderer. `NO_COLOR=1` and `PRETTY_PANE_COLOR=never` disable renderer-owned ANSI color.

### Install / update / remove

```bash
# Install (brew on macOS, apt on Debian/Ubuntu) and record the install in ~/.fh-agent/tmux.installed.
scripts/fh-agent install tmux

# Already have tmux? Just record it (no system install runs).
scripts/fh-agent install tmux --manual-mark

# Upgrade (brew upgrade / apt-get install --only-upgrade).
scripts/fh-agent update tmux

# Uninstall + clear state file. manager=manual deletes ONLY the marker (system tmux untouched).
scripts/fh-agent remove tmux
```

The Linux apt path runs `sudo -n true` first; if sudo would prompt for a password, the command aborts with a manual-fallback message rather than silently hanging (`RealCommandRunner` captures stdio).

### Per-invocation session id

When the launcher decides to enter tmux, it generates a fresh session name `fh-agent-<8 hex chars>` from `/dev/urandom` and exports it as `FH_AGENT_TMUX_SESSION`. Two terminals running `fh-agent` simultaneously get separate sessions and never collide. The launcher OWNS that name — it doesn't imply any specific extension; the user may go on to invoke a fh-team `fh_team_*` tool (which renames the session to a tool-derived alias) OR a different extension entirely inside the same session.

### Escape hatches

- `FH_AGENT_NO_TMUX=1` — env var that disables the launcher gate.
- `--no-tmux` — argv flag (launcher-only; stripped before reaching pi) that does the same.
- `$TMUX` already set — the launcher does NOT re-exec; the TS pane manager detects you are already in a session and uses `tmux display-message -p '#S'` to find the active session name (permissive validator accepts user sessions like `work` or `0`).
- tmux not installed — `should_use_tmux` returns false, the launcher proceeds without tmux, and the pane manager is a no-op.

### When tmux is NOT installed

`fh_team_*` tools work exactly as before — the orchestrator's pane-manager branch short-circuits when `getActiveSession()` returns null, so `subscribeAgent` does not open panes, the spawn helper does not pass `rawLogPath`, and `spawnAgent` skips the raw-stdout mirror entirely. Behavior is byte-for-byte identical.

### References

The tmux integration is inspired by these earlier projects (one-line attributions):

- [pi-teams](https://github.com/burggraf/pi-teams) — original pattern of routing per-agent output into tmux panes.
- [pi.dev/packages/pi-agentteam?name=tmux](https://pi.dev/packages/pi-agentteam?name=tmux) — variation with right-split layout.
- [pi.dev/packages/pi-side-agents?name=tmux](https://pi.dev/packages/pi-side-agents?name=tmux) — side-channel `tail -F` model (closest to ours).
- [pi.dev/packages/@ogulcancelik/pi-tmux?name=tmux](https://pi.dev/packages/@ogulcancelik/pi-tmux?name=tmux) — pane-naming + auto-close lifecycle.

We adopted the side-channel `tail -F` model: the agent process model is unchanged (still owned by pi as a child of the orchestrator); tmux only mirrors raw stdout/stderr into a pane that closes when the source ends.

## Safety properties

- **Reviewer subprocess isolation** — argv profile is immutable; tested via snapshot.
- **Universal secret scan** — centrally enforced in `spawnAgent` so every role spawn is scanned before exec; cannot be bypassed.
- **Dirty-worktree guard** — `task` and `followup` always (both run in the current working tree, no worktree-creation knob); `implement`/`auto` when `use_worktree=false`; baseline captured + strict staging.
- **Mandatory revise callback** — every review loop feeds findings back into a fresh role-agent spawn; same-payload re-review raises `RevisionUnchangedError`.
- **Per-folder lock** — atomic acquire via `mkdir`; rich metadata (`pid`, `processStartedAt`, `hostname`); takeover via rename-as-CAS. Defeats PID reuse and crash residue.
- **Process-tree cleanup on abort** — detached process group, `SIGTERM → 2s → SIGKILL`; `pendingKill` is awaited before `spawnAgent` resolves.

## Plan-folder layout

```
ai_plan/<YYYY-MM-DD-slug>/
  ├── original-plan.md
  ├── milestone-plan.md
  ├── story-tracker.md             ← live tracker, mutated atomically
  ├── continuation-runbook.md
  ├── final-transcript.md
  ├── execution-strategy.json      ← optional; validated strategy for parallel lanes
  ├── baseline.json                ← only when use_worktree=false
  ├── pr-description.md            ← generated at end of implement/auto/task/followup
  ├── research-answers.json        ← research Q&A cache (legacy plans may have `.research-answers.json` instead)
  ├── transcript/
  │   ├── planning/
  │   │   └── 0001-<role>-<label>[-round-N][-STATUS].md
  │   │   …
  │   └── implementation/
  │       └── 0001-<role>-<label>[-round-N][-STATUS].md
  │       …
  ├── diagnostics/
  │   └── diagnostics-<ISO-stamp>.log     ← one per failed run
  ├── reports/
  │   └── performance-<ISO-stamp>.md      ← one per run
  ├── .fh-team.lock/                       ← transient lockdir; metadata.json inside while a run owns the folder
  └── .fh-workflow/
      ├── workflow.json            ← durable owner/status/phase/worktree/branch metadata; includes `parentSlug` for followups
      ├── checkpoints.json         ← completed/failed step records with input/output fingerprints
      ├── verification-cache.json  ← persistent cache when opted in
      ├── steering/                ← inbox, decisions, applied-instructions ledger, active-agent registry, snapshots
      └── artifacts/               ← checkpoint payloads and reusable step outputs
```

`fh_team_followup` writes a brand-new sibling plan folder under `ai_plan/<date>-followup-<title-kebab>/` (e.g. `ai_plan/2026-05-08-followup-better-anim/`) using the same single-file `task-plan.md` layout as `fh_team_task`. The parent plan is referenced in the planner's brief and recorded in the followup's own `.fh-workflow/workflow.json` as `parentSlug`; the parent folder is not modified. Followup runs in the current branch (same as `fh_team_task`) — switch branches before invoking if a fresh branch is required.

Per-phase transcripts: each phase folder (`planning/`, `implementation/`) keeps its own counter that initializes from the highest existing sequence number on resume, so a resumed run never overwrites prior transcripts. System entries (validation-failed, patch transcripts) bucket by the active phase at write time.

Old plan folders are not migrated. Existing files at the old paths (`transcript/<NNNN>-...md` at the transcript root, `diagnostics-*.log` at the plan root, `performance-*.md` at the plan root) are left in place — the new code never touches them. Only new writes use the new layout. The single explicit read-side fallback is `qa.ts`: when only the legacy `.research-answers.json` exists (and the dotless `research-answers.json` is absent), the cache loader still reads it; the writer always emits the dotless name.
