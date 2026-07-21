---
name: sf-flow-audit
description: Use when a diff or codebase must receive a CodeRabbit-style audit — 7 finder angles, a dual-blind AND-gate, and fix-apply — returning P0–P3 findings and an APPROVED/REVISE verdict.
---

# sf-flow-audit

## Prerequisites
The `auditor` agent is at `~/.pi/agent/agents/auditor.md` (write-once). Auditor model resolved via config (`.pi/sf/flow/config.json` → `SF_FLOW_AUDITOR_MODEL` → inherit orchestrator). Threshold default `0.94`, `max_rounds` `5` (config: `audit.threshold` / `audit.max_rounds`).

## Agent resolution
Spawn the agent whose `.md` filename matches the role (`reviewer`→`reviewer`, `auditor`→`auditor`, `developer`→`developer`, …). `planner`/`reviewer` fall back to the built-in `Plan`/`Reviewer` only if no `.md` exists. Anything else with no `.md` → `general-purpose`. The orchestrator NEVER implements — it always delegates.

For research, use the `explorer` agent (matches `explorer.md`), NOT the built-in `Explore` (which forces Haiku). If no explorer model is configured, omit `model` so it inherits the orchestrator.

**Models (self-resolve):** resolve each agent's model from `.pi/sf/flow/config.json` (project) then `~/.pi/sf/flow/config.json` (global); if unset, omit `model` at dispatch so pi-subagents applies the agent `.md` `model:` or inherits the orchestrator. If a model was passed to you in your invocation context (the `sf_flow_*` tool echo on the direct path, or a workflow hint on the delegated path), use that — it wins. The tool's echo is visibility-only; you are the resolver.

## Process

### Phase 1: Gather the diff
Resolve the target to a diff string. If `target` is a ref range → `git diff <range>`. If a file → read it. If absent → `git diff HEAD` (staged+unstaged). Cap at `MAX_DIFF_CHARS` (200000) — truncate with a marker via `buildCodeReviewPrompt`.

### Phase 2: pi-dw /code-review (7 finder angles)
Dispatch the code-review builtin with `buildCodeReviewPrompt(diff, repoRoot)`. It fans out 7 finder agents (A/B/C correctness medium-tier, D/E/F cleanup small-tier, G altitude big-tier), verifies each finding (3-way CONFIRMED/PLAUSIBLE/REFUTED, drop REFUTED), dedups by file:line:summary, ranks correctness>cleanup>altitude, and synthesizes. Collect findings into the P0-P3 contract.

### Phase 3: audit-code self-checklist (--gate)
Run the 10-section checklist (`CHECKLIST_SECTIONS`) against the changed files (churn-ranked first). In `--gate` mode: `gateExitCode` returns 1 on ANY failure, 0 only if all pass. Write the full report to `specs/verifications/AUDIT-<slug>.md`.

### Phase 4: request-review (dual-blind AND-gate)
Dispatch TWO independent `auditor` agents (A, B) (`subagent_type: "auditor"`; model from config or inherit orchestrator), with NO shared context (neither sees the other's report). Compute each score via `qualityScore`; both must pass (`andGatePasses`: `mustFix==0 && score>=threshold`). If either fails → REVISE → respond-review → re-dispatch both. Max `MAX_REVIEW_ITERATIONS` (5); iteration 6 forbidden (`isApproved`).

### Phase 5: respond-review (fix-apply)
If `apply_fixes`: `categorize` findings (P0/P1 must-fix, P2 should-fix, P3 consider), `applyOrder` (severity), apply in order, run test/typecheck/lint, report. In auto mode: skip `consider` confirmations, note them. HARD GATE: every finding is addressed (fix, disagree+document, or clarify).

### Phase 6: Render + return
Render the merged findings via `renderReport` (pair's `### P0...P3` + `## Verdict` format). Return `VERDICT: APPROVED` only if no P0/P1/P2 remain (`isBlocking`).

## Telegram
On completion, send a summary via the notify-telegram helper (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`).
