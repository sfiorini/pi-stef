---
name: sf-flow-auto
description: Use when a defined flow (global ~/.pi/sf/flow/workflows or project .pi/sf/flow/workflows) must be run end-to-end with no human gates. Input may be a prompt, a markdown file, a PRD, or a Jira story.
---

# sf-flow-auto

## Purpose
Run a defined flow end-to-end, no human gates. Input forms: inline prompt, markdown file, PRD, or Jira story (resolved via @pi-stef/atlassian).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `researcher` agent (matches `researcher.md`). Do NOT use the built-in `Explore` agent (it forces Haiku and cannot access web tools).

Within the generated pi-dw script, each `agent:` phase resolves its agent type by this same rule (a declared agent spawns by name; an undeclared `planner`/`reviewer` falls back to `Plan`/`Reviewer`; anything else → `general-purpose`). `skill:` phases run INLINE: the orchestrator (YOU) reads + executes each skill file in full, dispatches role agents via the Agent tool, writes NO code itself, and spawns NO `general-purpose` subagent for a skill phase.

Models: every agent resolves from its `.md` file — project `.pi/agents/<name>.md` overrides global `~/.pi/agent/agents/<name>.md`; a `.md` with no `model:` inherits the orchestrator. **NEVER pass `model` at dispatch** — the generated `agent()` calls carry no model, and pi-subagents/pi-dynamic-workflows apply the `.md` model natively (frontmatter is authoritative); passing one would override it. The auto-ready Per-phase table is INFORMATIONAL only (where each agent's `.md` lives and which model it pins) — do not act on it beyond NOT passing a model.

## Slug
The run slug (`args.slug`) drives the `ai_plan/<slug>/` folder, `prompt.md`, the generated script's checkpoint dirs, and the `flow/<slug>` worktree branch — **one slug for everything**. Format: `<YYYY-MM-DD>-<max 4 words>` — a short lowercase kebab summary of the task that a human can read (e.g. `2026-08-04-cursor-sunset-fix`). When you invoke `sf_flow_auto` for a run, generate this slug from the input and pass it as the `slug` parameter; if you omit it, `sf_flow_auto` derives a deterministic fallback slug. Numbers are allowed in tokens; drop stopwords. The tool sanitizes whatever you pass (kebab, ≤4 tokens, owns the date prefix).

## Process

### Phase 0: Resume check
The sf_flow_auto tool already pre-seeded `ai_plan/<slug>/.flow-state.json` for this run: it resumes an existing state whose `workflowHash`+`inputHash` match (preserving progress), otherwise writes a fresh all-pending state. Call `sf_flow_checkpoint({ mode: "load-all", dir: \`ai_plan/${args.slug}\` })` — the view carries `workflowHash`/`inputHash` (verify they match this run), `phaseIndex`/`blockedPhase` (the first non-`success` checkpoint entity — a phase OR a group), `artifacts`, and `worktree`. If `blockedPhase` is non-null, **resume** there: re-run that phase/group from the top, reloading its required inputs from prior publishes. If everything is `pending` or the hashes differ, run fresh from phase 1. Resume only re-enters — it never reorders or skips. (A blocked group loop is a checkpoint entity, so resume re-runs the group rather than skipping past it to a later phase.)

### Phase 1: Resolve the flow
The sf_flow_auto tool already resolved the workflow file (project `<repo>/.pi/sf/flow/workflows` overrides global `~/.pi/sf/flow/workflows`), loaded + validated it (`loadFlowYaml`/`validateFlowYaml`), discovered the agents' `.md` files (report-only), derived the run-level `args.slug`, pre-seeded the checkpoint, and pre-generated the pi-dw script (idempotent) — all included in the tool output. Read the script from the tool output (no need to re-generate or re-validate). If the tool returned a not-found message instead, ask the user to create it via `/sf-flow-create-workflow` or run `/sf-flow-seed` to copy the bundled examples.

### Phase 2: Resolve the input
- `prompt` → use verbatim as the flow's `args.input`
- `md-file` → read the file, pass contents as `args.input`
- `prd` → parse the PRD file, pass as `args.input`
- `jira` → resolve the story via @pi-stef/atlassian (Jira), pass description+acceptance as `args.input`

The original input is captured at `ai_plan/<slug>/prompt.md` by sf_flow_auto (beside `.flow-state.json`) — read it from there if you need the verbatim input. **Never write the prompt, the brief, or any workflow artifact to the repo root** — the slug folder `ai_plan/<slug>/` is the single home for everything this run produces (plan files, reports, the brief, prompt.md). If a workflow has no plan phase (e.g. research), it still writes its reports under `ai_plan/<slug>/`.

### Phase 3: Run the flow (contract execution)
**Do not stop after reading this skill.** Execute the generated pi-dw script with `args = { input, flow, slug }` (bind `args.input` to the resolved input; `args.slug` is the run-level slug sf_flow_auto derived — every checkpoint call uses `dir: \`ai_plan/${args.slug}\``).

Each phase is a sequence of named steps backed by three helper tools the script calls **verbatim**:
- **sf_flow_contract** — `derive-slug` (the plan phase derives the slug and publishes it), `materialize` (write resume-safe artifact skeletons into the plan dir), `assert` (block on missing/empty artifacts).
- **sf_flow_checkpoint** — `load-required` (load + destructure prior publishes into JS consts; a missing one returns `blocked`), `complete` (atomic publish + mark success + persist), `load-all` (the terminal view).
- **sf_flow_prepare** — create the `flow/<slug>` worktree for an implement phase (the handle is published so the finalize phase recovers it on resume).

**Follow the emitted steps exactly — do not improvise, reorder, or skip.** This is the enforcement invariant: a phase that skips or fails its declared contract starves the next phase's `load-required` → a concrete `blocked` return, never a silent skip. A `{ status: "blocked" }` return is **terminal** — stop, report the `finalPhase` and `resumeState.stateFile`, and do not continue. `skill:` phases still run INLINE (read + execute the skill file, dispatch role agents); `questions:` phases run the clarifying-questions follow-up loop. Loops (`until_dry` / `until:approved`) run to convergence or a blocked non-convergence.

### Phase 4: Terminal state
The script returns a structured result: `{ name, status: "success" | "blocked", finalPhase, artifacts, worktree, branch, resumeState: { stateFile } }`.
- **success** — report the artifacts (the files under `ai_plan/<slug>/`) and the final state.
- **blocked** — stop and report `finalPhase` + `resumeState.stateFile`. The next `/sf-flow-auto` invocation resumes from there (Phase 0).

No human gates except declared `questions:` phases; every other phase runs to a terminal state.
