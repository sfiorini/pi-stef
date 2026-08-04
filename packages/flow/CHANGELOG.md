# Changelog

## [Unreleased]

## [0.11.1] - 2026-08-04
### Changed
- fix(flow): short slug, model directive, prompt-in-slug-folder (sf-flow-auto)


## [0.11.0] - 2026-08-04
### Changed
- test(flow): auto e2e + finalize-survival + assert-files fix (M9)
- docs(flow): contract model + tier-guarantees + walkthrough (M8)
- feat(flow): migrate workflows + agents to the contract model (M7)
- feat(flow): canonical-delta audit protocol (M6)
- feat(flow): milestone tracker + worktree cleanup reporting (M5)
- feat(flow): resume + orchestrator skill + messages + D18 threshold (M4)
- feat(flow): generator emission — contract steps, fail-closed gate, terminal (M3)
- feat(flow): helper tools — contract/checkpoint/prepare (M2)
- feat(flow): contract schema + validation (M1)


## [0.10.2] - 2026-08-03
### Changed
- test(flow): sandboxed-HOME PATH-resolution test for notifier (M3)
- fix(flow): resolve notify-telegram.sh via PATH-prepend in tier-1 skills (M2)
- fix(flow): resolve notify-telegram.sh via PATH-prepend in notifier agent (M1)


## [0.10.1] - 2026-08-03
### Changed
- fix(flow): route questions-phase diagnostic through configModelFor + doc nits (audit)
- docs(flow): README — tier-2 agents config-backed (S-61)
- feat(flow): reflect tier-2 config fallback in auto-ready diagnostic (M4)
- feat(flow): wire configModelFor into tier-2 agent + group-loop emit (M3)
- feat(flow): resolve notifier/scanner config models (M2)
- feat(flow): add notifier/scanner config groups + configModelFor (M1)


## [0.10.0] - 2026-08-03
### Changed
- feat(flow): wire opt-in notify phase into ship-feature + deep-research
- test(flow): cover notify-telegram.sh --message-file path (audit P3)
- docs(flow): sf-flow-seed skill — ten agents + notifier (S-53)
- docs(flow): README — notifier agent + Tier-2 notifications subsection (S-51)
- test(flow): add notifier yaml plumbing test (S-41)
- test(flow): add notify-telegram.sh mock-HTTP integration test (S-31)
- feat(flow): add notifier example to workflow template (S-22)
- feat(flow): make sf-flow-auto tier-2 (remove auto Phase 5 telegram) (S-21)
- feat(flow): register notifier in seed/agents + definition test (S-12)
- feat(flow): add notifier agent for opt-in Tier-2 notifications (S-11)


## [0.9.1] - 2026-08-02
### Changed
- fix(flow): sanitize flow name (path-traversal) + register-error path + missing list + tool desc (audit)
- docs(flow): README — adaptive create-workflow wizard + new params (S-41)
- feat(flow): rewrite sf-flow-create-workflow SKILL as adaptive wizard (S-31)
- feat(flow): real validate/write/register in sf_flow_create_workflow execute (S-22)
- test(flow): add sf_flow_create_workflow execute handler tests (S-21)
- feat(flow): add validateSection for partial-flow validation (S-12)
- feat(flow): export TypeBox section schemas (S-11)


## [0.9.0] - 2026-08-02
### Changed
- docs(flow): fix elicitor doc-comment nits (audit P3)
- docs(flow): fix resolveFlowModels JSDoc count (impl-review P3)
- docs(flow): document config-backed elicitor (M4 complete)
- docs(flow): partial README — elicitor config + env var (M4 WIP)
- feat(flow): report questions-phase elicitor model source (M3)
- feat(flow): config-fallback model for questions-phase elicitor (M2)
- feat(flow): add elicitor config group + resolution (M1)


## [0.8.0] - 2026-08-02
### Changed
- fix(flow): escape baked values in questions-phase directive (audit P2-1)
- docs(flow): update intro/header to 4-knob model (G5 P3)
- docs(flow): create-workflow wizard — questions + groups (S-74)
- docs(flow): README + docs-site — questions/groups knobs, 19-rule table, 9 agents (S-71..S-73)
- docs(flow): add elicitor to agents.ts JSDoc enumeration (G4 P3)
- chore(flow): standardize Telegram sentence across skills (S-63)
- chore(flow): vendor notify-telegram.sh into flow/bin + package.json bin (S-62)
- feat(flow): add elicitor to AGENT_FILES + update counts to nine (S-61)
- docs(flow): tier-1 prose emphasis notes in 4 SKILL.md files (S-54)
- feat(flow): add tier-2 behavior notes to 5 agent definitions (S-53)
- feat(flow): add elicitor agent for questions phases (S-52)
- docs(flow): expand workflow template with questions + groups examples (S-51)
- test(flow): update integration tests for decomposed workflows (S-43)
- feat(flow): rewrite code-review.yaml as audit↔fix group loop (S-42)
- feat(flow): decompose ship-feature.yaml into tier-2 phases (S-41)
- refactor(flow): align questions-phase esc with skill-phase (M2 review P3)
- feat(flow): conditional gates in auto-ready message (S-31,S-32)
- feat(flow): add questions branch + emitGroupLoop to generator (S-21,S-22,S-23)
- test(flow): cover questions+verify + raw-in-group (M1 review P2)
- feat(flow): make loops group-aware (S-15)
- feat(flow): add groups cross-field validation (S-14)
- feat(flow): expand runKinds to 4 kinds + questions validation rules (S-13)
- feat(flow): add GroupDef + groups map to FlowYamlSchema (S-12)
- feat(flow): add questions + max_rounds to PhaseDef schema (S-11)


## [0.7.0] - 2026-07-31
### Changed
- docs(flow): document delta-review protocol in README (plan/implement/audit loops)
- feat(flow): rewrite plan/implement/audit review loops to delta-review + add skills regression test
- feat(flow): add delta-review verification mode to reviewer/auditor + re-spawn contract to planner/developer
- feat(flow): add delta-review verification helper (assignFindingIds/parseVerification/evolveCanonical/verificationApproved)


## [0.6.0] - 2026-07-30
### Changed
- chore(flow): restore 0.5.0 + drop manual changelog (let pnpm release bump+tag)
- fix(flow): audit P2 — grant sf_web_login/session to researcher; P3 doc/clarity fixes
- docs(flow): fix stale workflow count in sf-flow-seed SKILL (P2)
- chore(flow): release 0.6.0 — version, changelog, docs (M5)
- docs(flow): atlassian/web sections, cross-links, README, SKILL no-halt (M4-B)
- feat(flow): promote deep-research workflow to built-in + seed (M3)
- feat(flow): researcher agent researches everywhere (web + atlassian) (M2)
- fix(flow): sf_flow_auto no longer halts after reading the skill (M1)


## [0.5.0] - 2026-07-28
### Changed
- fix(cursor): finalize maps SDK cancelled→terminal error + audit P3 polish [audit]
- chore(flow): Q4 live-capture script + runbook for model-hybrid trigger [M3]
- fix(flow): classify raw phase as 'other' in summarizePhaseModels [M2 P2]
- feat(flow): accurate per-phase model reporting + skill clarification [M2]
- feat(flow): atomic model-spec guard (normalizeModelSpec) + Tier-1 resolution wiring [M1]


## [0.4.1] - 2026-07-23
### Fixed
- fix(flow): `sf_flow_auto` now runs `skill:` phases INLINE in the orchestrator instead of spawning a nested `general-purpose` twin. The tool pre-generates the pi-dw script (loads + validates the YAML, resolves models via `loadAndResolveDefaults`, calls `generateScript`) and the skill-phase branch emits a `log()` inline directive naming the exact `SKILL.md` path (`skillDocPath`); the orchestrator reads + executes each skill itself — matching the direct `sf_flow_implement` path (one orchestrator, no twin). `buildAutoReadyMessage` now renders the script + a 7-row resolved-model table. The loop-on-skill-phase ban stays (a skill phase returns no structured verdict to gate on).
- fix(flow): escape backticks and `${` in the skill-phase `log()` directive's baked-in values (`skill`/`flow.name`/`skillPath`/`hint`) so a stray backtick or `${` in a workflow name can't break the emitted template literal; the runtime interpolations `${args.flow}`/`${args.slug}` stay literal.

## [0.4.0] - 2026-07-22
### Changed
- Consolidate `explorer` into `researcher` — flow now ships 8 agents (was 9). `researcher` is a single non-isolated, web-capable agent that handles both codebase and web research with cited claims. It is the 7th config-backed group (`researcher.model` / `SF_FLOW_RESEARCHER_MODEL` / `researcher_model` param). The `research-report` example flow's inline `model: sonnet` overrides the config value for that flow.
- `isValidModelToken` extraction hardening — shared guard across all three model extractors (reviewer/researcher/designer) rejects bogus regex captures like `"and"` or `"or"`; accepts known aliases (`sonnet`, `haiku`, …) and versioned names (`gpt-4o`, `anthropic/sonnet-4-6`).
- Pre-validation config migration — a legacy `"explorer"` key in `config.json` is auto-renamed to `"researcher"` before schema validation, so existing configs continue to load without manual edits.

### ⚠️ Breaking
- **Config key rename:** `explorer` → `researcher` in `config.json`. Auto-migrated if only `explorer` is present (both keys → `researcher` wins). No action needed unless you have both keys.
- **Env var rename:** `SF_FLOW_EXPLORER_MODEL` is **not** auto-migrated. Set `SF_FLOW_RESEARCHER_MODEL` instead.
- **Param rename:** `explorer_model` → `researcher_model` in `sf_flow_plan` tool invocation.
- **`explorer.md` removed from shipped agents:** flow no longer seeds `explorer.md`. A previously seeded global `~/.pi/agent/agents/explorer.md` is preserved (write-once). Pair is unaffected — pair still ships its own `explorer.md`. To adopt flow's consolidated researcher, delete the old seeded `explorer.md` and re-seed with `/sf-flow-seed`.
## [0.2.0] - 2026-07-21
### Changed (breaking)
- feat(flow): per-agent model registry — all 6 agents (`reviewer`/`explorer`/`developer`/`planner`/`auditor`/`synth`) now have optional config groups; uniform fallback (unset ⇒ inherits the orchestrator model, **no fail-fast**).
- feat(flow): tier-1 skills (`sf-flow-plan`/`sf-flow-implement`/`sf-flow-audit`) **self-resolve** models from `config.json` (project → global → env → inherit). A workflow delegating via a `skill:` phase now honors config too. Tools pre-resolve + echo (visibility only).
- feat(flow): deterministic agent-type resolution (`resolveAgentType`) — match-by-`.md`-name; `planner`/`reviewer` fall back to built-in `Plan`/`Reviewer`; anything else → `general-purpose`. A missing `explorer.md` no longer falls back to `Explore` (which forced Haiku). Wired into `generate.ts` for Tier 2 flows.
- feat(flow): enforce exhaustive milestone-plan generation — the plan standard (7 required per-story fields, no vague verbs, zero-remaining-design-decisions bar) + a completeness self-check + a reviewer gate that REVISEs under-detailed stories. Applies to both the plan tool and workflow plan phases.
- feat(flow): `/sf-flow-implement` is now orchestrator-only — it delegates each milestone to the `developer` agent (TDD) and runs the per-milestone reviewer gate; the orchestrator writes no code.
- fix(flow): `skill:`-phase artifact handoff — conventional slug-keyed paths (`ai_plan/<slug>/`, `flow/<slug>` worktree) via `args.flow`/`args.slug`; dropped the broken placeholder const. `generateScript(flow, {models?})` bakes an optional tier-1 model hint.
- refactor(flow): remove dead tmux visualization (no `src/` imported it; `isEnabled()` read only `SF_FLOW_NO_TMUX`). Use pi-subagents' own visualization.

### ⚠️ Breaking
- **Remove any `tmux` block from your `.pi/sf/flow/config.json`** — the schema is `additionalProperties: false`, so a `tmux` key now fails validation. (`SF_FLOW_NO_TMUX` is gone too.)
- An unset reviewer model **no longer errors** — it now inherits the orchestrator model (uniform fallback). The old "No reviewer model configured" tool error is gone.

## [0.3.0] - 2026-07-22
### Added
- `designer` agent (7th config-backed group) + config wiring; see sf-flow-plan Phase 4.

### Changed
- `planner` agent now invokes superpowers:writing-plans (with embedded fallback); retains the 7-field plan standard.
- sf-flow-plan Phase 4 dispatches the `designer` agent (interactive relay loop); Phase 5 dispatches the `planner` agent.

## [0.2.1] - 2026-07-22
### Changed
- audit(P3): clarify scanner tool-use mandate (grep for patterns, never read whole files)
- story-id: S-2.4 CHANGELOG [Unreleased] entry
- story-id: S-2.3 /sf-flow-seed skill: 6→8 agents
- story-id: S-2.1 README: 8 agents + config distinction
- story-id: S-1.4 Update ensureAgentFiles JSDoc (six→eight)
- story-id: S-1.3 Add scanner/researcher to AGENT_FILES (GREEN)
- story-id: S-1.2 Create agents/scanner.md + agents/researcher.md
- story-id: S-1.1 Expand FLOW_AGENTS to 8 (RED)

### Changed
- feat(flow): ship agent definitions for the example-workflow agents — `scanner` (`auth-audit`) and `researcher` (`research-report`) now ship as write-once `.md` files in `agents/` and are seeded by `/sf-flow-seed` + lazy `ensureAgentFiles`. Previously these roles resolved to `general-purpose`. Eight agents now ship (six config-backed + two Tier-2 example agents whose model is set inline in their workflow YAML; `config.json` unchanged at six groups).

## [0.1.7] - 2026-07-17
### Changed
- fix(flow): load-time workflow registration crashed under pi's extension loader — `Value.Cast` is not callable there (while `Value.Errors`/`Value.Check`, used across pair/team/flow, work fine). Replaced the `Value.Cast` normalization in `loadFlowYaml` with strict `validateFlowYaml`-only validation (also preferable to silent coercion).
- test(flow): regression guard — `loadFlowYaml` must accept every bundled example workflow (the `Value.Cast` bug slipped through because tests used hand-written YAML, not the shipped files).

## [0.1.6] - 2026-07-17
### Changed
- feat(flow): global-scoped default workflows — examples now live at `~/.pi/sf/flow/workflows/` (available in every project); a project override at `.pi/sf/flow/workflows/<name>.yaml` shadows a global
- feat(flow): `/sf-flow-seed` command + `sf_flow_seed` tool — copy default agents + example workflows globally; re-seed writes `<name>.new` for changed files (never clobbers edits)
- feat(flow): load-time registration of `/<name>` workflow commands (`/code-review`, …) — `registerGeneratedFlow` was previously dead code
- feat(flow): `sf_flow_auto` resolves the workflow file (project→global) in the tool handler and passes the absolute path
- fix(flow): TOCTOU-safe seeding via exclusive (`wx`) create
- fix(flow): reject reserved flow names (`sf-flow-`/`sf_flow_` prefix) in `validateFlowYaml`
- docs(flow): README + docs-site updated for global workflows + `/sf-flow-seed`

## [0.1.5] - 2026-07-17
### Changed
- fix(flow): add /sf-flow-* slash commands (command -> tool -> skill, like pair)

## [0.1.4] - 2026-07-17
### Changed
- fix(pair,flow): make skills internal (path-loaded) to remove duplicate /skill:* listing

## [0.1.3] - 2026-07-17
### Changed
- fix(flow): add required frontmatter (name+description) to the 5 skills

## [0.1.2] - 2026-07-17
### Changed
- fix(flow): address review — code-review dead agent, model-source accuracy, test gap
- feat(flow): auto-seed example workflows into .pi/workflows/
- docs(flow): add Model precedence + /sf-flow-audit vs code-review flow sections
- docs(flow): comprehensive rewrite — mental model, agents/workflows/config, 3-knob reference

## [0.1.1] - 2026-07-16
### Changed
- feat(flow): register in catalog + docs-site; README + flow.md + CHANGELOG
- test(flow): end-to-end integration (YAML->script->chain, audit gate)
- feat(flow): example workflows (auth-audit, ship-feature, code-review, research-report)
- fix(flow): accurate shouldAdopt doc + try/catch controller callbacks (M6 P3)
- feat(flow): tmux manager + event-subscription controller (created->open, terminal->close)
- feat(flow): tmux renderer (port team pretty-pane, codex/plain themes)
- docs(flow): tmux event-bus spike findings
- fix(flow): surface explorer model + agent warnings (M5 parity)
- fix(flow): guard null reviewerModel in sf_flow_implement (M5 P1)
- feat(flow): sf-flow-plan/implement/auto tools + skills
- feat(flow): auto input classifier (prompt/md-file/prd/jira)
- feat(flow): sf-flow-audit skill + tool (full triad)
- feat(flow): request-review dual-blind AND-gate + respond-review fix-apply
- feat(flow): audit codereview wrapper + audit-code self-checklist/gate/score
- feat(flow): audit verdict contract (P0-P3 + APPROVED/REVISE)
- fix(flow): correct writeFlowYamlAsync JSDoc + add async test (M3 polish)
- feat(flow): sf-flow-create-workflow wizard + workflow.yaml template
- fix(flow): quote-safe meta name/titles + self-validating register (M2 polish)
- fix(flow): reject duplicate out values (M2 P2)
- fix(flow): enforce agent/skill/raw mutual exclusivity (M2 P2)
- fix(flow): M2 review fixes — emit tools, fail_on gate, robust slash handler
- feat(flow): register generated flow as /<name> command
- feat(flow): YAML -> pi-dynamic-workflows script generator
- feat(flow): cross-field YAML validation
- feat(flow): declarative workflow YAML schema (3 knobs)
- fix(flow): make audit/tmux/worktree Optional in config schema
- feat(flow): register skeleton + sf_flow_finalize tool
- feat(flow): worktree create/validate/cleanup/finalize (port pair's)
- feat(flow): ensureAgentFiles + 6 bundled agent definitions
- feat(flow): config schema + layered load (port pair's)
- feat(flow): scaffold @pi-stef/flow package + extension entry

## 0.1.0

- Initial release of `@pi-stef/flow`.
- Reusable declarative workflows (agents/phases/loops YAML + deterministic generator).
- `sf-flow-plan`, `sf-flow-implement`, `sf-flow-audit`, `sf-flow-auto`, `sf-flow-create-workflow`.
- CodeRabbit-style audit triad (pi-dw `/code-review` + bigpowers dual-blind AND-gate).
- tmux agent visualization (adapted from team).
