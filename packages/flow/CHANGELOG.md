# Changelog

## [Unreleased]

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
